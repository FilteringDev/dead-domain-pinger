import * as Core from '@actions/core'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import * as Process from 'node:process'
import * as Zod from 'zod'
import { BuildDomainCandidates, SelectProbeWork } from './sources/candidate-selection.ts'
import { CollectDomainOccurrences } from './sources/collect-domains.ts'
import { LoadGlobalpingConfig } from './sources/config.ts'
import { IsShallowRepository } from './sources/domain-history.ts'
import { ListFilterFiles } from './sources/filter-files.ts'
import { DefaultMaxCandidates } from './sources/globalping.ts'
import { GetDefaultOrderingWorkerCount } from './sources/ordering-pool.ts'
import { BuildGitDiff, DiffFileName, ResolvePreviewOutputDirectory, WritePreviewArtifacts, type PreviewFileChange } from './sources/preview.ts'
import { GetDefaultWorkerCount, ProbeDomainsWithWorkers } from './sources/probe-pool.ts'
import { BuildPullRequestBody, BuildReportMarkdown, PullRequestBodyFileName, ReportFileName, type ReportInput } from './sources/report.ts'
import { RewriteFilterContent, type DeadDomainsByOrigin } from './sources/rewrite-filters.ts'
import { FilterOccurrencesByScanDirectories } from './sources/scan-directories.ts'
import { ClearPendingProbe, CreateEmptyState, LoadState, QueuePendingProbe, RecordVerdict, SaveState, StateFileName } from './sources/state.ts'
import { DomainOrigins, type DomainOrigin, type RuleChange } from './sources/types.ts'

const Env = await Zod.object({
  DRY_RUN: Zod.string().default('false').transform(Value => Value === 'true'),
  ALWAYS_REFRESH: Zod.string().default('false').transform(Value => Value === 'true'),
  PREVIEW_OUTPUT_DIRECTORY: Zod.string().default(''),
  FILTER_ROOT: Zod.string().nonempty().default('.'),
  SCAN_DIRECTORIES: Zod.string().default(''),
  FILE_EXTENSION: Zod.string().nonempty().default('.txt'),
  STATE_DIRECTORY: Zod.string().nonempty().default('dead-domain-state'),
  SQLITE_STATE_PATH: Zod.string().nonempty().optional(),
  GLOBALPING_API_TOKEN: Zod.string().min(1, 'GLOBALPING_API_TOKEN is required'),
  MAX_CANDIDATES: Zod.string().default(String(DefaultMaxCandidates)).transform(Value => Number(Value)),
  ORDERING_WORKER_COUNT: Zod.string().default('').transform(Value => Value === '' ? GetDefaultOrderingWorkerCount() : Number(Value)),
  WORKER_COUNT: Zod.string().default('').transform(Value => Value === '' ? GetDefaultWorkerCount() : Number(Value))
}).strip()
  .superRefine((Value, Context) => {
    if (!Number.isInteger(Value.MAX_CANDIDATES) || Value.MAX_CANDIDATES <= 0) {
      Context.addIssue({ code: 'custom', path: ['MAX_CANDIDATES'], message: 'MAX_CANDIDATES must be a positive integer' })
      return
    }

    if (!Number.isInteger(Value.WORKER_COUNT) || Value.WORKER_COUNT <= 0) {
      Context.addIssue({ code: 'custom', path: ['WORKER_COUNT'], message: 'WORKER_COUNT must be a positive integer' })
    }

    if (!Number.isInteger(Value.ORDERING_WORKER_COUNT) || Value.ORDERING_WORKER_COUNT <= 0) {
      Context.addIssue({ code: 'custom', path: ['ORDERING_WORKER_COUNT'], message: 'ORDERING_WORKER_COUNT must be a positive integer' })
    }

    if (Value.DRY_RUN && !Value.PREVIEW_OUTPUT_DIRECTORY) {
      Context.addIssue({ code: 'custom', path: ['PREVIEW_OUTPUT_DIRECTORY'], message: 'PREVIEW_OUTPUT_DIRECTORY is required in dry-run mode' })
    }

    if (Value.ALWAYS_REFRESH && !Value.DRY_RUN) {
      Context.addIssue({ code: 'custom', path: ['ALWAYS_REFRESH'], message: 'ALWAYS_REFRESH is only supported by local dry-run mode' })
    }

    if (Value.ALWAYS_REFRESH && Value.SQLITE_STATE_PATH) {
      Context.addIssue({ code: 'custom', path: ['ALWAYS_REFRESH'], message: 'ALWAYS_REFRESH cannot be combined with SQLITE_STATE_PATH' })
    }
  })
  .parseAsync(Process.env)

const WorkingDirectory = Process.env.CI_WORKSPACE_PATH ?? Process.cwd()
const OrderingWorkingDirectory = Process.env.ORDERING_WORKSPACE_PATH || WorkingDirectory
const PreviewOutputDirectory = Env.DRY_RUN && Env.PREVIEW_OUTPUT_DIRECTORY
  ? ResolvePreviewOutputDirectory(WorkingDirectory, Env.PREVIEW_OUTPUT_DIRECTORY)
  : null
const StateDirectory = Path.resolve(WorkingDirectory, Env.STATE_DIRECTORY)
const StateFilePath = Env.SQLITE_STATE_PATH ? Path.resolve(Env.SQLITE_STATE_PATH) : Path.resolve(StateDirectory, StateFileName)
const CheckedAt = Math.floor(Date.now() / 1000)
const GlobalpingConfig = LoadGlobalpingConfig(WorkingDirectory)

const FilterFiles = ListFilterFiles(WorkingDirectory, { RootDirectory: Env.FILTER_ROOT, FileExtension: Env.FILE_EXTENSION })
Core.info(`[dead-domain-pinger] Loaded ${FilterFiles.length} filter list files`)

const Occurrences = CollectDomainOccurrences(WorkingDirectory, FilterFiles)
const KnownDomains = new Set(Occurrences.map(Occurrence => Occurrence.Domain))
Core.info(`[dead-domain-pinger] Found ${KnownDomains.size} unique domains in ${Occurrences.length} occurrences`)
const ScopedOccurrences = FilterOccurrencesByScanDirectories(WorkingDirectory, Occurrences, Env.SCAN_DIRECTORIES)
const ScopedDomains = new Set(ScopedOccurrences.map(Occurrence => Occurrence.Domain))
if (Env.SCAN_DIRECTORIES.trim()) {
  Core.info(`[dead-domain-pinger] Limited candidates to ${ScopedDomains.size} unique domains in ${ScopedOccurrences.length} occurrences under the configured scan directories`)
}

const State = Env.ALWAYS_REFRESH
  ? CreateEmptyState(GlobalpingConfig.JudgementPreferences.Fingerprint)
  : await LoadState(StateFilePath, GlobalpingConfig.JudgementPreferences.Fingerprint)

if (await IsShallowRepository(OrderingWorkingDirectory)) {
  Core.warning('[dead-domain-pinger] The repository is a shallow clone, so every domain looks equally recent — check it out with `fetch-depth: 0`')
}

const Candidates = await BuildDomainCandidates({
  WorkingDirectory: OrderingWorkingDirectory,
  Occurrences: ScopedOccurrences,
  State,
  FallbackAuthorTime: CheckedAt,
  OrderingWorkerCount: Env.ORDERING_WORKER_COUNT,
  OnOrderingWarning: Message => Core.warning(`[dead-domain-pinger] ${Message}`)
})
Core.info(`[dead-domain-pinger] Ordered domains from Git history with up to ${Env.ORDERING_WORKER_COUNT} workers`)
const SelectedWork = SelectProbeWork(Candidates, State, Env.MAX_CANDIDATES)
Core.info(`[dead-domain-pinger] Selected ${SelectedWork.length} probe jobs with ${Env.WORKER_COUNT} workers (limit ${GlobalpingConfig.Limit} per measurement)`)

const { ProbeResults, ProbeFailedDomains, RateLimited, RateLimitMessage } = await ProbeDomainsWithWorkers({
  WorkItems: SelectedWork,
  ApiToken: Env.GLOBALPING_API_TOKEN,
  Locations: GlobalpingConfig.Locations,
  Limit: GlobalpingConfig.Limit,
  CheckedAt,
  WorkerCount: Env.WORKER_COUNT,
  JudgementPreferences: GlobalpingConfig.JudgementPreferences
})

// SQLite state is owned by the main process; probe workers only return serializable results.
for (const Result of ProbeResults) {
  RecordVerdict(State, Result.Domain, Result.Verdict, CheckedAt, Result.Warnings, Result.ModifiedAtOverride ?? undefined)
  ClearPendingProbe(State, Result.Domain)

  if (Result.NextProbe) {
    QueuePendingProbe(State, Result.Domain, Result.NextProbe.Target, Result.NextProbe.Kind)
    Core.notice(`[dead-domain-pinger] ${Result.Domain}: queued ${Result.NextProbe.Target} over HTTP for the next run (${Result.NextProbe.Kind})`)
  }

  if (ProbeFailedDomains.has(Result.Domain)) {
    Core.warning(`[dead-domain-pinger] ${Result.Domain} via ${Result.Protocol} ${Result.Target}: probe failed — ${Result.Reason}`)
  } else {
    Core.info(`[dead-domain-pinger] ${Result.Domain} via ${Result.Protocol} ${Result.Target}: ${Result.Verdict} (${Result.Reason})`)
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

const DeadDomainsByOrigin: DeadDomainsByOrigin = {
  networkPattern: new Set(),
  domainList: new Set()
}

for (const Result of ProbeResults) {
  for (const Origin of DomainOrigins) {
    if (Result.Judgements[Origin]?.Verdict === 'Dead') {
      DeadDomainsByOrigin[Origin].add(Result.Domain)
    }
  }
}

const DeadDomainOrigins = Object.fromEntries(
  [...new Set(DomainOrigins.flatMap(Origin => [...DeadDomainsByOrigin[Origin]]))]
    .sort((Left, Right) => Left.localeCompare(Right))
    .map(Domain => [
      Domain,
      DomainOrigins.filter(Origin => DeadDomainsByOrigin[Origin].has(Domain))
    ])
) as Record<string, DomainOrigin[]>
const DeadDomains = new Set(Object.keys(DeadDomainOrigins))
Core.info(`[dead-domain-pinger] ${DeadDomains.size} domains judged dead in at least one origin`)

const AffectedFiles = new Set(
  Candidates.flatMap(Candidate => Candidate.Occurrences
    .filter(Occurrence => DeadDomainsByOrigin[Occurrence.Origin].has(Occurrence.Domain))
    .map(Occurrence => Occurrence.FilePath))
)

const ModifiedRules: RuleChange[] = []
const RemovedRules: RuleChange[] = []
const ChangedFiles: string[] = []
const PreviewFileChanges: PreviewFileChange[] = []

for (const FilePath of [...AffectedFiles].sort((A, B) => A.localeCompare(B))) {
  const AbsolutePath = Path.resolve(WorkingDirectory, FilePath)
  const Content = Fs.readFileSync(AbsolutePath, 'utf-8')
  const Result = RewriteFilterContent(FilePath, Content, DeadDomainsByOrigin)

  if (!Result.Changed) {
    continue
  }

  ModifiedRules.push(...Result.ModifiedRules)
  RemovedRules.push(...Result.RemovedRules)
  ChangedFiles.push(FilePath)
  PreviewFileChanges.push({
    FilePath,
    OriginalContent: Content,
    ProposedContent: Result.Content
  })

  if (!Env.DRY_RUN) {
    Fs.writeFileSync(AbsolutePath, Result.Content, 'utf-8')
  }
}

if (!Env.DRY_RUN) {
  await SaveState(StateFilePath, State, KnownDomains)
}

const RunUrl = Process.env.GITHUB_SERVER_URL && Process.env.GITHUB_REPOSITORY && Process.env.GITHUB_RUN_ID
  ? `${Process.env.GITHUB_SERVER_URL}/${Process.env.GITHUB_REPOSITORY}/actions/runs/${Process.env.GITHUB_RUN_ID}`
  : null

const Report: ReportInput = {
  DryRun: Env.DRY_RUN,
  SelectedCount: SelectedWork.length,
  ProbeResults,
  RateLimited,
  ChangedFiles,
  ModifiedRules,
  RemovedRules,
  RunUrl
}

const ReportMarkdown = BuildReportMarkdown(Report)
let ReportFilePath: string
let PullRequestBodyFilePath: string | null
let DiffFilePath: string | null

if (Env.DRY_RUN) {
  if (!PreviewOutputDirectory) {
    throw new Error('Preview output directory was not configured')
  }

  ReportFilePath = Path.resolve(PreviewOutputDirectory, ReportFileName)
  PullRequestBodyFilePath = null
  DiffFilePath = Path.resolve(PreviewOutputDirectory, DiffFileName)
  WritePreviewArtifacts(PreviewOutputDirectory, BuildGitDiff(PreviewFileChanges), ReportMarkdown)
} else {
  ReportFilePath = Path.resolve(StateDirectory, ReportFileName)
  PullRequestBodyFilePath = Path.resolve(StateDirectory, PullRequestBodyFileName)
  DiffFilePath = null

  Fs.mkdirSync(StateDirectory, { recursive: true })
  Fs.writeFileSync(ReportFilePath, `${ReportMarkdown}\n`, 'utf-8')
  Fs.writeFileSync(PullRequestBodyFilePath, `${BuildPullRequestBody(Report)}\n`, 'utf-8')
}

const WarningCount = ProbeResults.reduce((Total, Result) => Total + Result.Warnings.length, 0)
const HasChanges = ChangedFiles.length > 0

if (Process.env.LOCAL_PREVIEW !== 'true') {
  Core.setOutput('has_changes', String(HasChanges))
  Core.setOutput('dead_domains', JSON.stringify([...DeadDomains].sort((Left, Right) => Left.localeCompare(Right))))
  Core.setOutput('dead_domain_origins', JSON.stringify(DeadDomainOrigins))
  Core.setOutput('changed_files', JSON.stringify(ChangedFiles))
  Core.setOutput('probed_count', String(ProbeResults.length))
  Core.setOutput('rate_limited', String(RateLimited))
  Core.setOutput('warning_count', String(WarningCount))
  Core.setOutput('report_path', Path.relative(WorkingDirectory, ReportFilePath))
  Core.setOutput('diff_path', DiffFilePath ? Path.relative(WorkingDirectory, DiffFilePath) : '')
  Core.setOutput('pr_body_path', PullRequestBodyFilePath ? Path.relative(WorkingDirectory, PullRequestBodyFilePath) : '')
}

Core.info(ReportMarkdown)

if (!Env.DRY_RUN && Process.env.GITHUB_STEP_SUMMARY) {
  Fs.appendFileSync(Process.env.GITHUB_STEP_SUMMARY, `${ReportMarkdown}\n`, 'utf-8')
}
