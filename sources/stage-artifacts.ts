import * as Path from 'node:path'
import * as Zod from 'zod'
import { DomainOrigins, type DomainCandidate, type DomainOccurrence } from './types.ts'
import { GetLastCheckedAt, GetModifiedAtOverride, type DeadDomainState, type GitOrderCacheEntry } from './state.ts'
import { ParseScanDirectories } from './scan-directories.ts'

export const WorkerArtifactVersion = 1

const DomainOriginSchema = Zod.enum(DomainOrigins)
const DomainOccurrenceSchema = Zod.object({
  Domain: Zod.string().nonempty(),
  FilePath: Zod.string().nonempty(),
  LineNumber: Zod.number().int().positive(),
  Origin: DomainOriginSchema
}).strict()

const DomainCandidateSchema = Zod.object({
  Domain: Zod.string().nonempty(),
  LatestModifiedAt: Zod.number().nonnegative(),
  LastCheckedAt: Zod.number().nonnegative(),
  ModifiedAtOverride: Zod.number().nonnegative(),
  SortKey: Zod.number().nonnegative(),
  Occurrences: Zod.array(DomainOccurrenceSchema),
  Origins: Zod.array(DomainOriginSchema).min(1)
}).strict()

const GitOrderCacheEntrySchema = Zod.object({
  FilePath: Zod.string().nonempty(),
  Revision: Zod.string().nonempty(),
  LineNumber: Zod.number().int().positive(),
  Domain: Zod.string().nonempty(),
  ModifiedAt: Zod.number().nonnegative()
}).strict()

export const WorkerArtifactSchema = Zod.object({
  Version: Zod.literal(WorkerArtifactVersion),
  ScopeId: Zod.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
  Candidates: Zod.array(DomainCandidateSchema),
  GitOrderCache: Zod.array(GitOrderCacheEntrySchema),
  ConsideredCount: Zod.number().int().nonnegative(),
  UrlFilterSelectedCount: Zod.number().int().nonnegative(),
  FallbackCount: Zod.number().int().nonnegative(),
  Warnings: Zod.array(Zod.string())
}).strict()

export type WorkerArtifact = Zod.infer<typeof WorkerArtifactSchema>

export type MatrixEntry = {
  Id: string
  Directory: string
}

function IsWithinWorkspace(WorkingDirectory: string, FilePath: string): boolean {
  const Relative = Path.relative(WorkingDirectory, Path.resolve(WorkingDirectory, FilePath))
  return Relative === '' || (!Relative.startsWith(`..${Path.sep}`) && Relative !== '..' && !Path.isAbsolute(Relative))
}

/** Rejects artifact paths that could cause postprocess to access files outside the checkout. */
export function AssertWorkerArtifactPaths(WorkingDirectory: string, Artifact: WorkerArtifact): void {
  for (const Candidate of Artifact.Candidates) {
    for (const Occurrence of Candidate.Occurrences) {
      if (!IsWithinWorkspace(WorkingDirectory, Occurrence.FilePath)) {
        throw new Error(`Worker artifact ${Artifact.ScopeId} contains an occurrence outside the workspace: ${Occurrence.FilePath}`)
      }
    }
  }
  for (const Entry of Artifact.GitOrderCache) {
    if (!IsWithinWorkspace(WorkingDirectory, Entry.FilePath)) {
      throw new Error(`Worker artifact ${Artifact.ScopeId} contains a cache entry outside the workspace: ${Entry.FilePath}`)
    }
  }
}

function IsParentDirectory(Parent: string, Child: string): boolean {
  const Relative = Path.relative(Parent, Child)
  return Relative === '' || (!Relative.startsWith(`..${Path.sep}`) && Relative !== '..' && !Path.isAbsolute(Relative))
}

function ToScopeId(Directory: string, Index: number): string {
  const Slug = Directory === '.'
    ? 'root'
    : Directory.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/(^-|-$)/gu, '') || 'scope'
  return `${Slug}-${Index + 1}`
}

/** Creates non-overlapping, repository-relative matrix entries from action scan directories. */
export function BuildMatrixEntries(WorkingDirectory: string, ScanDirectories: string): MatrixEntry[] {
  const Directories = ParseScanDirectories(WorkingDirectory, ScanDirectories)
  if (Directories.length === 0) {
    return [{ Id: 'root-1', Directory: '.' }]
  }

  const CanonicalDirectories = [...new Set(Directories.map(Directory => Path.relative(WorkingDirectory, Directory) || '.'))]
    .sort((Left, Right) => Left.localeCompare(Right))
  const Entries = CanonicalDirectories.filter((Directory, Index) => !CanonicalDirectories
    .slice(0, Index)
    .some(Parent => IsParentDirectory(Path.resolve(WorkingDirectory, Parent), Path.resolve(WorkingDirectory, Directory))))

  if (Entries.length > 256) {
    throw new Error(`Configured scan directories produce ${Entries.length} matrix jobs, exceeding GitHub Actions' 256-job limit`)
  }

  return Entries.map((Directory, Index) => ({ Id: ToScopeId(Directory, Index), Directory }))
}

function OccurrenceKey(Occurrence: DomainOccurrence): string {
  return `${Occurrence.Domain}\u0000${Occurrence.FilePath}\u0000${Occurrence.LineNumber}\u0000${Occurrence.Origin}`
}

/** Merges worker output and reapplies persisted state so the global queue has one authoritative order. */
export function MergeWorkerArtifacts(Artifacts: WorkerArtifact[], State: DeadDomainState): DomainCandidate[] {
  const CandidatesByDomain = new Map<string, DomainCandidate>()

  for (const Artifact of Artifacts) {
    for (const Candidate of Artifact.Candidates) {
      const Existing = CandidatesByDomain.get(Candidate.Domain)
      if (!Existing) {
        CandidatesByDomain.set(Candidate.Domain, {
          ...Candidate,
          Occurrences: [...Candidate.Occurrences],
          Origins: [...Candidate.Origins]
        })
        continue
      }

      Existing.LatestModifiedAt = Math.max(Existing.LatestModifiedAt, Candidate.LatestModifiedAt)
      const Occurrences = new Set(Existing.Occurrences.map(OccurrenceKey))
      for (const Occurrence of Candidate.Occurrences) {
        if (!Occurrences.has(OccurrenceKey(Occurrence))) {
          Occurrences.add(OccurrenceKey(Occurrence))
          Existing.Occurrences.push(Occurrence)
        }
      }
      for (const Origin of Candidate.Origins) {
        if (!Existing.Origins.includes(Origin)) {
          Existing.Origins.push(Origin)
        }
      }
      Existing.Origins.sort((Left, Right) => DomainOrigins.indexOf(Left) - DomainOrigins.indexOf(Right))
    }
  }

  return [...CandidatesByDomain.values()]
    .map(Candidate => {
      const LastCheckedAt = GetLastCheckedAt(State, Candidate.Domain)
      const ModifiedAtOverride = GetModifiedAtOverride(State, Candidate.Domain)
      return {
        ...Candidate,
        LastCheckedAt,
        ModifiedAtOverride,
        SortKey: Math.max(Candidate.LatestModifiedAt, LastCheckedAt, ModifiedAtOverride)
      }
    })
    .sort((Left, Right) => Left.SortKey - Right.SortKey || Left.Domain.localeCompare(Right.Domain))
}

/** Returns unique cache records suitable for the single postprocess state writer. */
export function MergeGitOrderCache(Artifacts: WorkerArtifact[], ExistingEntries: GitOrderCacheEntry[] = []): GitOrderCacheEntry[] {
  const Entries = new Map<string, GitOrderCacheEntry>()
  for (const Entry of ExistingEntries) {
    const Key = `${Entry.FilePath}\u0000${Entry.Revision}\u0000${Entry.LineNumber}\u0000${Entry.Domain}`
    Entries.set(Key, Entry)
  }
  for (const Artifact of Artifacts) {
    for (const Entry of Artifact.GitOrderCache) {
      const Key = `${Entry.FilePath}\u0000${Entry.Revision}\u0000${Entry.LineNumber}\u0000${Entry.Domain}`
      Entries.set(Key, Entry)
    }
  }
  return [...Entries.values()].sort((Left, Right) => Left.FilePath.localeCompare(Right.FilePath)
    || Left.Revision.localeCompare(Right.Revision)
    || Left.LineNumber - Right.LineNumber
    || Left.Domain.localeCompare(Right.Domain))
}