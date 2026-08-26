import * as Core from '@actions/core'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import * as Process from 'node:process'
import * as Zod from 'zod'
import { BuildDomainCandidates, SelectOldestDomains } from './sources/candidate-selection.ts'
import { CollectDomainOccurrences } from './sources/collect-domains.ts'
import { IsShallowRepository } from './sources/domain-history.ts'
import { ListFilterFiles } from './sources/filter-files.ts'
import { MaxMeasurementsPerRun } from './sources/globalping.ts'
import { GetDefaultWorkerCount, ProbeDomainsWithWorkers } from './sources/probe-pool.ts'
import { BuildPullRequestBody, BuildReportMarkdown, PullRequestBodyFileName, ReportFileName, type ReportInput } from './sources/report.ts'
import { RewriteFilterContent } from './sources/rewrite-filters.ts'
import { LoadState, RecordVerdict, SaveState, StateFileName } from './sources/state.ts'
import type { RuleChange } from './sources/types.ts'

const Env = await Zod.object({
  DRY_RUN: Zod.string().default('false').transform(Value => Value === 'true'),
  FILTER_ROOT: Zod.string().nonempty().default('.'),
  FILE_EXTENSION: Zod.string().nonempty().default('.txt'),
  STATE_DIRECTORY: Zod.string().nonempty().default('dead-domain-state'),
  SQLITE_STATE_PATH: Zod.string().nonempty().optional(),
  GLOBALPING_API_TOKEN: Zod.string().default(''),
  MAX_CANDIDATES: Zod.string().default(String(MaxMeasurementsPerRun)).transform(Value => Number(Value)),
  WORKER_COUNT: Zod.string().default('').transform(Value => Value === '' ? GetDefaultWorkerCount() : Number(Value))
}).strip()
  .superRefine((Value, Context) => {
    if (!Number.isInteger(Value.MAX_CANDIDATES) || Value.MAX_CANDIDATES <= 0) {
      Context.addIssue({ code: 'custom', path: ['MAX_CANDIDATES'], message: 'MAX_CANDIDATES must be a positive integer' })
      return
    }

    // Above the anonymous quota, Globalping requires an API token to authenticate the higher limit.
    if (Value.MAX_CANDIDATES > MaxMeasurementsPerRun && Value.GLOBALPING_API_TOKEN.length === 0) {
      Context.addIssue({ code: 'custom', path: ['MAX_CANDIDATES'], message: `MAX_CANDIDATES may only exceed ${MaxMeasurementsPerRun} when globalping-api-token is set` })
    }

    if (!Number.isInteger(Value.WORKER_COUNT) || Value.WORKER_COUNT <= 0) {
      Context.addIssue({ code: 'custom', path: ['WORKER_COUNT'], message: 'WORKER_COUNT must be a positive integer' })
    }
  })
  .parseAsync(Process.env)

const WorkingDirectory = Process.env.CI_WORKSPACE_PATH ?? Process.cwd()
const StateDirectory = Path.resolve(WorkingDirectory, Env.STATE_DIRECTORY)
const StateFilePath = Env.SQLITE_STATE_PATH ? Path.resolve(Env.SQLITE_STATE_PATH) : Path.resolve(StateDirectory, StateFileName)
const CheckedAt = Math.floor(Date.now() / 1000)

const FilterFiles = ListFilterFiles(WorkingDirectory, { RootDirectory: Env.FILTER_ROOT, FileExtension: Env.FILE_EXTENSION })
Core.info(`[dead-domain-pinger] Loaded ${FilterFiles.length} filter list files`)

const Occurrences = CollectDomainOccurrences(WorkingDirectory, FilterFiles)
const KnownDomains = new Set(Occurrences.map(Occurrence => Occurrence.Domain))
Core.info(`[dead-domain-pinger] Found ${KnownDomains.size} unique domains in ${Occurrences.length} occurrences`)

const State = await LoadState(StateFilePath)

if (await IsShallowRepository(WorkingDirectory)) {
  Core.warning('[dead-domain-pinger] The repository is a shallow clone, so every domain looks equally recent — check it out with `fetch-depth: 0`')
}

const Candidates = await BuildDomainCandidates({
  WorkingDirectory,
  Occurrences,
  State,
  FallbackAuthorTime: CheckedAt
})
const SelectedCandidates = SelectOldestDomains(Candidates, Env.MAX_CANDIDATES)
Core.info(`[dead-domain-pinger] Selected ${SelectedCandidates.length} oldest domains for probing with ${Env.WORKER_COUNT} workers`)

const { ProbeResults, ProbeFailedDomains, RateLimited, RateLimitMessage } = await ProbeDomainsWithWorkers({
  Candidates: SelectedCandidates,
  ApiToken: Env.GLOBALPING_API_TOKEN || undefined,
  CheckedAt,
  WorkerCount: Env.WORKER_COUNT
})

// SQLite state is owned by the main process; probe workers only return serializable results.
for (const Result of ProbeResults) {
  RecordVerdict(State, Result.Domain, Result.Verdict, CheckedAt, Result.Warnings, Result.ModifiedAtOverride ?? undefined)

  if (ProbeFailedDomains.has(Result.Domain)) {
    Core.warning(`[dead-domain-pinger] ${Result.Domain}: probe failed — ${Result.Reason}`)
  } else {
    Core.info(`[dead-domain-pinger] ${Result.Domain}: ${Result.Verdict} (${Result.Reason})`)
  }

  if (Result.ModifiedAtOverride !== null) {
    Core.notice(`[dead-domain-pinger] ${Result.Domain}: redirects to ${Result.SameDomainRedirects.join(', ')} within the same registrable domain — kept, last-modified date overridden to ${new Date(Result.ModifiedAtOverride * 1000).toISOString()}`)
  }

  for (const Warning of Result.Warnings) {
    Core.warning(`[dead-domain-pinger] ${Result.Domain}: ${Warning}`)
  }
}

if (RateLimited) {
  Core.warning(`[dead-domain-pinger] ${RateLimitMessage ?? 'Globalping rate limit reached'} — stopping further probes`)
}

const DeadDomains = new Set(ProbeResults.filter(Result => Result.Verdict === 'Dead').map(Result => Result.Domain))
Core.info(`[dead-domain-pinger] ${DeadDomains.size} domains judged dead`)

const AffectedFiles = new Set(
  SelectedCandidates
    .filter(Candidate => DeadDomains.has(Candidate.Domain))
    .flatMap(Candidate => Candidate.Occurrences.map(Occurrence => Occurrence.FilePath))
)

const ModifiedRules: RuleChange[] = []
const RemovedRules: RuleChange[] = []
const ChangedFiles: string[] = []

for (const FilePath of [...AffectedFiles].sort((A, B) => A.localeCompare(B))) {
  const AbsolutePath = Path.resolve(WorkingDirectory, FilePath)
  const Content = Fs.readFileSync(AbsolutePath, 'utf-8')
  const Result = RewriteFilterContent(FilePath, Content, DeadDomains)

  if (!Result.Changed) {
    continue
  }

  ModifiedRules.push(...Result.ModifiedRules)
  RemovedRules.push(...Result.RemovedRules)
  ChangedFiles.push(FilePath)

  if (!Env.DRY_RUN) {
    Fs.writeFileSync(AbsolutePath, Result.Content, 'utf-8')
  }
}

await SaveState(StateFilePath, State, KnownDomains)

const RunUrl = Process.env.GITHUB_SERVER_URL && Process.env.GITHUB_REPOSITORY && Process.env.GITHUB_RUN_ID
  ? `${Process.env.GITHUB_SERVER_URL}/${Process.env.GITHUB_REPOSITORY}/actions/runs/${Process.env.GITHUB_RUN_ID}`
  : null

const Report: ReportInput = {
  DryRun: Env.DRY_RUN,
  SelectedCount: SelectedCandidates.length,
  ProbeResults,
  RateLimited,
  ChangedFiles,
  ModifiedRules,
  RemovedRules,
  RunUrl
}

const ReportMarkdown = BuildReportMarkdown(Report)
const ReportFilePath = Path.resolve(StateDirectory, ReportFileName)
const PullRequestBodyFilePath = Path.resolve(StateDirectory, PullRequestBodyFileName)

Fs.mkdirSync(StateDirectory, { recursive: true })
Fs.writeFileSync(ReportFilePath, `${ReportMarkdown}\n`, 'utf-8')
Fs.writeFileSync(PullRequestBodyFilePath, `${BuildPullRequestBody(Report)}\n`, 'utf-8')

const WarningCount = ProbeResults.reduce((Total, Result) => Total + Result.Warnings.length, 0)
const HasChanges = ChangedFiles.length > 0

Core.setOutput('has_changes', String(HasChanges && !Env.DRY_RUN))
Core.setOutput('dead_domains', JSON.stringify([...DeadDomains]))
Core.setOutput('changed_files', JSON.stringify(ChangedFiles))
Core.setOutput('probed_count', String(ProbeResults.length))
Core.setOutput('rate_limited', String(RateLimited))
Core.setOutput('warning_count', String(WarningCount))
Core.setOutput('report_path', Path.relative(WorkingDirectory, ReportFilePath))
Core.setOutput('pr_body_path', Path.relative(WorkingDirectory, PullRequestBodyFilePath))

Core.info(ReportMarkdown)

if (Process.env.GITHUB_STEP_SUMMARY) {
  Fs.appendFileSync(Process.env.GITHUB_STEP_SUMMARY, `${ReportMarkdown}\n`, 'utf-8')
}
