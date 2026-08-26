import type { DomainCandidate, DomainOccurrence, ProbeWorkItem } from './types.ts'
import { GetLastCheckedAt, GetModifiedAtOverride, type DeadDomainState } from './state.ts'
import { GetDomainModifiedTimes } from './domain-history.ts'

export type BuildCandidatesOptions = {
  WorkingDirectory: string
  Occurrences: DomainOccurrence[]
  State: DeadDomainState
  /** Used when a line has no git history yet, so brand new lines are ranked as the newest ones. */
  FallbackAuthorTime: number
}

/**
 * Deduplicates domains, resolves the newest modification time of every domain and returns them
 * sorted from the least recently touched one to the most recent one.
 */
export async function BuildDomainCandidates(Options: BuildCandidatesOptions): Promise<DomainCandidate[]> {
  const OccurrencesByFile = Map.groupBy(Options.Occurrences, Occurrence => Occurrence.FilePath)

  const ModifiedTimesByFile = new Map<string, Map<string, number>>()
  for (const [FilePath, FileOccurrences] of OccurrencesByFile) {
    ModifiedTimesByFile.set(
      FilePath,
      await GetDomainModifiedTimes(Options.WorkingDirectory, FilePath, FileOccurrences, Options.FallbackAuthorTime)
    )
  }

  const CandidatesByDomain = new Map<string, DomainCandidate>()

  for (const Occurrence of Options.Occurrences) {
    const ModifiedAt = ModifiedTimesByFile.get(Occurrence.FilePath)?.get(Occurrence.Domain) ?? Options.FallbackAuthorTime
    const Existing = CandidatesByDomain.get(Occurrence.Domain)

    if (!Existing) {
      const LastCheckedAt = GetLastCheckedAt(Options.State, Occurrence.Domain)
      const ModifiedAtOverride = GetModifiedAtOverride(Options.State, Occurrence.Domain)

      CandidatesByDomain.set(Occurrence.Domain, {
        Domain: Occurrence.Domain,
        LatestModifiedAt: ModifiedAt,
        LastCheckedAt,
        ModifiedAtOverride,
        SortKey: Math.max(ModifiedAt, LastCheckedAt, ModifiedAtOverride),
        Occurrences: [Occurrence]
      })
      continue
    }

    Existing.Occurrences.push(Occurrence)
    // The most recent mention of a domain decides how "fresh" that domain is.
    Existing.LatestModifiedAt = Math.max(Existing.LatestModifiedAt, ModifiedAt)
    Existing.SortKey = Math.max(Existing.LatestModifiedAt, Existing.LastCheckedAt, Existing.ModifiedAtOverride)
  }

  return [...CandidatesByDomain.values()].sort((A, B) => {
    return A.SortKey - B.SortKey || A.Domain.localeCompare(B.Domain)
  })
}

export function SelectOldestDomains(Candidates: DomainCandidate[], MaxCandidates: number): DomainCandidate[] {
  return Candidates.slice(0, Math.max(0, MaxCandidates))
}

/** Returns persisted HTTP follow-ups first, then the least-recently-touched HTTPS candidates. */
export function SelectProbeWork(Candidates: DomainCandidate[], State: DeadDomainState, MaxCandidates: number): ProbeWorkItem[] {
  const MaxWorkItems = Math.max(0, MaxCandidates)
  const CandidatesByDomain = new Map(Candidates.map(Candidate => [Candidate.Domain, Candidate]))
  const PriorityWork = Object.entries(State.PendingProbes)
    .filter(([SourceDomain]) => CandidatesByDomain.has(SourceDomain))
    .sort(([Left], [Right]) => Left.localeCompare(Right))
    .map(([SourceDomain, PendingProbe]) => ({
      SourceDomain,
      Target: PendingProbe.Target,
      Protocol: 'HTTP' as const,
      PriorityKind: PendingProbe.Kind
    }))

  const PendingDomains = new Set(PriorityWork.map(Work => Work.SourceDomain))
  const NormalWork = Candidates
    .filter(Candidate => !PendingDomains.has(Candidate.Domain))
    .map(Candidate => ({
      SourceDomain: Candidate.Domain,
      Target: Candidate.Domain,
      Protocol: 'HTTPS' as const,
      PriorityKind: null
    }))

  return [...PriorityWork, ...NormalWork].slice(0, MaxWorkItems)
}
