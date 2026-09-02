import * as Core from '@actions/core'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import * as Process from 'node:process'
import * as Zod from 'zod'
import { SelectProbeWork } from './sources/candidate-selection.ts'
import { CollectDomainOccurrences } from './sources/collect-domains.ts'
import { LoadGlobalpingConfig } from './sources/config.ts'
import { ListFilterFiles } from './sources/filter-files.ts'
import { DefaultMaxCandidates } from './sources/globalping.ts'
import { BuildGitDiff, DiffFileName, ResolvePreviewOutputDirectory, WritePreviewArtifacts, type PreviewFileChange } from './sources/preview.ts'
import { GetDefaultWorkerCount, ProbeDomainsWithWorkers } from './sources/probe-pool.ts'
import { BuildPullRequestBody, BuildReportMarkdown, PullRequestBodyFileName, ReportFileName, type ReportInput } from './sources/report.ts'
import { RewriteFilterContent, type DeadDomainsByOrigin } from './sources/rewrite-filters.ts'
import { AssertWorkerArtifactPaths, MergeGitOrderCache, MergeWorkerArtifacts, WorkerArtifactSchema, type WorkerArtifact } from './sources/stage-artifacts.ts'
import { ClearPendingProbe, LoadState, QueuePendingProbe, RecordVerdict, SaveState } from './sources/state.ts'
import { DomainOrigins, type DomainOrigin, type RuleChange } from './sources/types.ts'

const Env = Zod.object({
  DRY_RUN: Zod.string().default('false').transform(Value => Value === 'true'),
  PREVIEW_OUTPUT_DIRECTORY: Zod.string().default(''),
  FILTER_ROOT: Zod.string().nonempty().default('.'),
  FILE_EXTENSION: Zod.string().nonempty().default('.txt'),
  STATE_DIRECTORY: Zod.string().nonempty().default('dead-domain-state'),
  SQLITE_STATE_PATH: Zod.string().nonempty(),
  WORKER_ARTIFACT_DIRECTORY: Zod.string().nonempty(),
  EXPECTED_WORKER_COUNT: Zod.string().transform(Number),
  GLOBALPING_API_TOKEN: Zod.string().min(1, 'GLOBALPING_API_TOKEN is required'),
  MAX_CANDIDATES: Zod.string().default(String(DefaultMaxCandidates)).transform(Number),
  WORKER_COUNT: Zod.string().default('').transform(Value => Value === '' ? GetDefaultWorkerCount() : Number(Value))
}).superRefine((Value, Context) => {
  if (!Number.isInteger(Value.EXPECTED_WORKER_COUNT) || Value.EXPECTED_WORKER_COUNT <= 0) {
    Context.addIssue({ code: 'custom', path: ['EXPECTED_WORKER_COUNT'], message: 'EXPECTED_WORKER_COUNT must be a positive integer' })
  }
  if (!Number.isInteger(Value.MAX_CANDIDATES) || Value.MAX_CANDIDATES <= 0) {
    Context.addIssue({ code: 'custom', path: ['MAX_CANDIDATES'], message: 'MAX_CANDIDATES must be a positive integer' })
  }
  if (!Number.isInteger(Value.WORKER_COUNT) || Value.WORKER_COUNT <= 0) {
    Context.addIssue({ code: 'custom', path: ['WORKER_COUNT'], message: 'WORKER_COUNT must be a positive integer' })
  }
  if (Value.DRY_RUN && !Value.PREVIEW_OUTPUT_DIRECTORY) {
    Context.addIssue({ code: 'custom', path: ['PREVIEW_OUTPUT_DIRECTORY'], message: 'PREVIEW_OUTPUT_DIRECTORY is required in dry-run mode' })
  }
}).parse(Process.env)

function ListArtifactFiles(Directory: string): string[] {
  if (!Fs.existsSync(Directory)) {
    return []
  }
  const Files: string[] = []
  for (const Entry of Fs.readdirSync(Directory, { withFileTypes: true })) {
    const EntryPath = Path.join(Directory, Entry.name)
    if (Entry.isDirectory()) {
      Files.push(...ListArtifactFiles(EntryPath))
    } else if (Entry.isFile() && Entry.name.endsWith('.json')) {
      Files.push(EntryPath)
    }
  }
  return Files.sort((Left, Right) => Left.localeCompare(Right))
}

function LoadWorkerArtifacts(WorkingDirectory: string, Directory: string, ExpectedCount: number): WorkerArtifact[] {
  const Artifacts = ListArtifactFiles(Directory).map(FilePath => WorkerArtifactSchema.parse(JSON.parse(Fs.readFileSync(FilePath, 'utf-8'))))
  const ScopeIds = new Set(Artifacts.map(Artifact => Artifact.ScopeId))
  if (Artifacts.length !== ExpectedCount || ScopeIds.size !== ExpectedCount) {
    throw new Error(`Expected ${ExpectedCount} unique worker artifacts but found ${Artifacts.length} files for ${ScopeIds.size} scopes`)
  }
  Artifacts.forEach(Artifact => AssertWorkerArtifactPaths(WorkingDirectory, Artifact))
  return Artifacts
}

const WorkingDirectory = Process.env.CI_WORKSPACE_PATH ?? Process.cwd()
const StateDirectory = Path.resolve(WorkingDirectory, Env.STATE_DIRECTORY)
const PreviewOutputDirectory = Env.DRY_RUN ? ResolvePreviewOutputDirectory(WorkingDirectory, Env.PREVIEW_OUTPUT_DIRECTORY) : null
const CheckedAt = Math.floor(Date.now() / 1000)
const GlobalpingConfig = LoadGlobalpingConfig(WorkingDirectory)
const Artifacts = LoadWorkerArtifacts(WorkingDirectory, Env.WORKER_ARTIFACT_DIRECTORY, Env.EXPECTED_WORKER_COUNT)
const State = await LoadState(Env.SQLITE_STATE_PATH, GlobalpingConfig.JudgementPreferences.Fingerprint)
State.GitOrderCache = MergeGitOrderCache(Artifacts, State.GitOrderCache)
const Candidates = MergeWorkerArtifacts(Artifacts, State)
const SelectedWork = SelectProbeWork(Candidates, State, Env.MAX_CANDIDATES)
Core.info(`[dead-domain-pinger] Merged ${Artifacts.length} worker artifacts into ${Candidates.length} candidates; selected ${SelectedWork.length} oldest jobs`)

const { ProbeResults, ProbeFailedDomains, RateLimited, RateLimitMessage } = await ProbeDomainsWithWorkers({
  WorkItems: SelectedWork,
  ApiToken: Env.GLOBALPING_API_TOKEN,
  Locations: GlobalpingConfig.Locations,
  Limit: GlobalpingConfig.Limit,
  CheckedAt,
  WorkerCount: Env.WORKER_COUNT,
  JudgementPreferences: GlobalpingConfig.JudgementPreferences
})

for (const Result of ProbeResults) {
  RecordVerdict(State, Result.Domain, Result.Verdict, CheckedAt, Result.Warnings, Result.ModifiedAtOverride ?? undefined)
  ClearPendingProbe(State, Result.Domain)
  if (Result.NextProbe) {
    QueuePendingProbe(State, Result.Domain, Result.NextProbe.Target, Result.NextProbe.Kind)
  }
  if (ProbeFailedDomains.has(Result.Domain)) {
    Core.warning(`[dead-domain-pinger] ${Result.Domain}: probe failed - ${Result.Reason}`)
  }
  for (const Warning of Result.Warnings) {
    Core.warning(`[dead-domain-pinger] ${Result.Domain}: ${Warning}`)
  }
}
if (RateLimited) {
  Core.warning(`[dead-domain-pinger] ${RateLimitMessage ?? 'Globalping rate limit reached'} - stopping further probes`)
}

const DeadDomainsByOrigin: DeadDomainsByOrigin = { networkPattern: new Set(), domainList: new Set() }
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
    .map(Domain => [Domain, DomainOrigins.filter(Origin => DeadDomainsByOrigin[Origin].has(Domain))])
) as Record<string, DomainOrigin[]>
const AffectedFiles = new Set(Candidates.flatMap(Candidate => Candidate.Occurrences
  .filter(Occurrence => DeadDomainsByOrigin[Occurrence.Origin].has(Occurrence.Domain))
  .map(Occurrence => Occurrence.FilePath)))
const ModifiedRules: RuleChange[] = []
const RemovedRules: RuleChange[] = []
const ChangedFiles: string[] = []
const PreviewFileChanges: PreviewFileChange[] = []

for (const FilePath of [...AffectedFiles].sort((Left, Right) => Left.localeCompare(Right))) {
  const AbsolutePath = Path.resolve(WorkingDirectory, FilePath)
  const Content = Fs.readFileSync(AbsolutePath, 'utf-8')
  const Rewrite = RewriteFilterContent(FilePath, Content, DeadDomainsByOrigin)
  if (!Rewrite.Changed) {
    continue
  }
  ModifiedRules.push(...Rewrite.ModifiedRules)
  RemovedRules.push(...Rewrite.RemovedRules)
  ChangedFiles.push(FilePath)
  PreviewFileChanges.push({ FilePath, OriginalContent: Content, ProposedContent: Rewrite.Content })
  if (!Env.DRY_RUN) {
    Fs.writeFileSync(AbsolutePath, Rewrite.Content, 'utf-8')
  }
}

const FilterFiles = ListFilterFiles(WorkingDirectory, { RootDirectory: Env.FILTER_ROOT, FileExtension: Env.FILE_EXTENSION })
const KnownDomains = new Set(CollectDomainOccurrences(WorkingDirectory, FilterFiles).map(Occurrence => Occurrence.Domain))
if (!Env.DRY_RUN) {
  await SaveState(Env.SQLITE_STATE_PATH, State, KnownDomains)
}

const RunUrl = Process.env.GITHUB_SERVER_URL && Process.env.GITHUB_REPOSITORY && Process.env.GITHUB_RUN_ID
  ? `${Process.env.GITHUB_SERVER_URL}/${Process.env.GITHUB_REPOSITORY}/actions/runs/${Process.env.GITHUB_RUN_ID}`
  : null
const Report: ReportInput = { DryRun: Env.DRY_RUN, SelectedCount: SelectedWork.length, ProbeResults, RateLimited, ChangedFiles, ModifiedRules, RemovedRules, RunUrl }
const ReportMarkdown = BuildReportMarkdown(Report)
let ReportFilePath: string
let PullRequestBodyFilePath: string | null
let DiffFilePath: string | null
if (Env.DRY_RUN) {
  ReportFilePath = Path.resolve(PreviewOutputDirectory!, ReportFileName)
  DiffFilePath = Path.resolve(PreviewOutputDirectory!, DiffFileName)
  PullRequestBodyFilePath = null
  WritePreviewArtifacts(PreviewOutputDirectory!, BuildGitDiff(PreviewFileChanges), ReportMarkdown)
} else {
  Fs.mkdirSync(StateDirectory, { recursive: true })
  ReportFilePath = Path.resolve(StateDirectory, ReportFileName)
  PullRequestBodyFilePath = Path.resolve(StateDirectory, PullRequestBodyFileName)
  DiffFilePath = null
  Fs.writeFileSync(ReportFilePath, `${ReportMarkdown}\n`, 'utf-8')
  Fs.writeFileSync(PullRequestBodyFilePath, `${BuildPullRequestBody(Report)}\n`, 'utf-8')
}

Core.setOutput('has_changes', String(ChangedFiles.length > 0))
Core.setOutput('dead_domains', JSON.stringify(Object.keys(DeadDomainOrigins)))
Core.setOutput('dead_domain_origins', JSON.stringify(DeadDomainOrigins))
Core.setOutput('changed_files', JSON.stringify(ChangedFiles))
Core.setOutput('probed_count', String(ProbeResults.length))
Core.setOutput('rate_limited', String(RateLimited))
Core.setOutput('warning_count', String(ProbeResults.reduce((Total, Result) => Total + Result.Warnings.length, 0)))
Core.setOutput('report_path', Path.relative(WorkingDirectory, ReportFilePath))
Core.setOutput('diff_path', DiffFilePath ? Path.relative(WorkingDirectory, DiffFilePath) : '')
Core.setOutput('pr_body_path', PullRequestBodyFilePath ? Path.relative(WorkingDirectory, PullRequestBodyFilePath) : '')
Core.info(ReportMarkdown)