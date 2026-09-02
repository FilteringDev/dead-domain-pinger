import * as Core from '@actions/core'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import * as Process from 'node:process'
import * as Zod from 'zod'
import { BuildDomainCandidates } from './sources/candidate-selection.ts'
import { CollectDomainOccurrences } from './sources/collect-domains.ts'
import { LoadGlobalpingConfig } from './sources/config.ts'
import { ListFilterFiles } from './sources/filter-files.ts'
import { GetDefaultOrderingWorkerCount } from './sources/ordering-pool.ts'
import { ParseScanDirectories } from './sources/scan-directories.ts'
import { WorkerArtifactSchema } from './sources/stage-artifacts.ts'
import { CreateEmptyState, LoadState } from './sources/state.ts'
import { SelectUrlFilteredProbeWork } from './sources/urlfilter-selection.ts'

const Env = Zod.object({
  FILTER_ROOT: Zod.string().nonempty().default('.'),
  SCAN_DIRECTORY: Zod.string().nonempty(),
  SCOPE_ID: Zod.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
  FILE_EXTENSION: Zod.string().nonempty().default('.txt'),
  SQLITE_STATE_PATH: Zod.string().default(''),
  ORDERING_WORKER_COUNT: Zod.string().default('').transform(Value => Value === '' ? GetDefaultOrderingWorkerCount() : Number(Value)),
  URLFILTER_PREFETCH_MULTIPLIER: Zod.string().default('100').transform(Number),
  WORKER_ARTIFACT_PATH: Zod.string().nonempty()
}).superRefine((Value, Context) => {
  if (!Number.isInteger(Value.ORDERING_WORKER_COUNT) || Value.ORDERING_WORKER_COUNT <= 0) {
    Context.addIssue({ code: 'custom', path: ['ORDERING_WORKER_COUNT'], message: 'ORDERING_WORKER_COUNT must be a positive integer' })
  }
  if (!Number.isInteger(Value.URLFILTER_PREFETCH_MULTIPLIER) || Value.URLFILTER_PREFETCH_MULTIPLIER <= 0) {
    Context.addIssue({ code: 'custom', path: ['URLFILTER_PREFETCH_MULTIPLIER'], message: 'URLFILTER_PREFETCH_MULTIPLIER must be a positive integer' })
  }
}).parse(Process.env)

const WorkingDirectory = Process.env.CI_WORKSPACE_PATH ?? Process.cwd()
const [ScopeDirectory] = ParseScanDirectories(WorkingDirectory, Env.SCAN_DIRECTORY)
if (!ScopeDirectory) {
  throw new Error('SCAN_DIRECTORY must name exactly one workspace-relative directory')
}

const FilterRoot = Path.resolve(WorkingDirectory, Env.FILTER_ROOT)
const RelativeScope = Path.relative(FilterRoot, ScopeDirectory)
if (RelativeScope.startsWith(`..${Path.sep}`) || RelativeScope === '..' || Path.isAbsolute(RelativeScope)) {
  throw new Error(`SCAN_DIRECTORY must be inside FILTER_ROOT: ${Env.SCAN_DIRECTORY}`)
}

const GlobalpingConfig = LoadGlobalpingConfig(WorkingDirectory)
const State = Env.SQLITE_STATE_PATH && Fs.existsSync(Env.SQLITE_STATE_PATH)
  ? await LoadState(Env.SQLITE_STATE_PATH, GlobalpingConfig.JudgementPreferences.Fingerprint)
  : CreateEmptyState(GlobalpingConfig.JudgementPreferences.Fingerprint)
const CacheBeforeOrdering = new Set(State.GitOrderCache.map(Entry => `${Entry.FilePath}\u0000${Entry.Revision}\u0000${Entry.LineNumber}\u0000${Entry.Domain}`))
const FilterFiles = ListFilterFiles(WorkingDirectory, { RootDirectory: Path.relative(WorkingDirectory, ScopeDirectory), FileExtension: Env.FILE_EXTENSION })
const Occurrences = CollectDomainOccurrences(WorkingDirectory, FilterFiles)
const Candidates = await BuildDomainCandidates({
  WorkingDirectory,
  Occurrences,
  State,
  FallbackAuthorTime: Math.floor(Date.now() / 1000),
  OrderingWorkerCount: Env.ORDERING_WORKER_COUNT,
  OnOrderingWarning: Message => Core.warning(`[dead-domain-pinger] ${Message}`)
})
const Selected = await SelectUrlFilteredProbeWork({
  Candidates,
  State,
  MaxCandidates: Candidates.length,
  PrefetchMultiplier: Env.URLFILTER_PREFETCH_MULTIPLIER,
  OnWarning: Message => Core.warning(`[dead-domain-pinger] ${Message}`)
})
const CandidateByDomain = new Map(Candidates.map(Candidate => [Candidate.Domain, Candidate]))
const Artifact = WorkerArtifactSchema.parse({
  Version: 1,
  ScopeId: Env.SCOPE_ID,
  Candidates: Selected.WorkItems.map(Work => CandidateByDomain.get(Work.SourceDomain)).filter(Candidate => Candidate !== undefined),
  GitOrderCache: State.GitOrderCache.filter(Entry => !CacheBeforeOrdering.has(`${Entry.FilePath}\u0000${Entry.Revision}\u0000${Entry.LineNumber}\u0000${Entry.Domain}`)),
  ConsideredCount: Selected.ConsideredCount,
  UrlFilterSelectedCount: Selected.UrlFilterSelectedCount,
  FallbackCount: Selected.FallbackCount,
  Warnings: []
})

Fs.mkdirSync(Path.dirname(Env.WORKER_ARTIFACT_PATH), { recursive: true })
Fs.writeFileSync(Env.WORKER_ARTIFACT_PATH, `${JSON.stringify(Artifact)}\n`, 'utf-8')
Core.setOutput('candidate_count', String(Artifact.Candidates.length))
Core.info(`[dead-domain-pinger] ${Env.SCOPE_ID}: wrote ${Artifact.Candidates.length} URL Filter-selected candidates`)