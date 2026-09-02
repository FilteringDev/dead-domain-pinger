import { SelectProbeWork } from './candidate-selection.ts'
import { FindUnusedDomains } from './urlfilter.ts'
import type { DomainCandidate, ProbeWorkItem } from './types.ts'
import type { DeadDomainState } from './state.ts'

const UrlFilterBatchSize = 1000

export type SelectUrlFilteredProbeWorkOptions = {
  Candidates: DomainCandidate[]
  State: DeadDomainState
  MaxCandidates: number
  PrefetchMultiplier: number
  FindUnusedDomains?: typeof FindUnusedDomains
  OnWarning?: (Message: string) => void
}

export type UrlFilteredProbeWork = {
  WorkItems: ProbeWorkItem[]
  ConsideredCount: number
  UrlFilterSelectedCount: number
  FallbackCount: number
}

function SplitIntoBatches<Thing>(Values: Thing[], BatchSize: number): Thing[][] {
  const Batches: Thing[][] = []
  for (let Index = 0; Index < Values.length; Index += BatchSize) {
    Batches.push(Values.slice(Index, Index + BatchSize))
  }
  return Batches
}

/**
 * Selects pending-first, Git-history-ordered work after URL Filter identifies unused registered domains.
 * A failed URL Filter batch falls back to Globalping so the selector never blocks cleanup runs.
 */
export async function SelectUrlFilteredProbeWork(Options: SelectUrlFilteredProbeWorkOptions): Promise<UrlFilteredProbeWork> {
  const MaxCandidates = Math.max(0, Options.MaxCandidates)
  if (MaxCandidates === 0) {
    return { WorkItems: [], ConsideredCount: 0, UrlFilterSelectedCount: 0, FallbackCount: 0 }
  }

  const PrefetchSize = Math.max(MaxCandidates, MaxCandidates * Options.PrefetchMultiplier)
  const AllWork = SelectProbeWork(Options.Candidates, Options.State, Options.Candidates.length)
  const FindUnused = Options.FindUnusedDomains ?? FindUnusedDomains
  const WorkItems: ProbeWorkItem[] = []
  let ConsideredCount = 0
  let UrlFilterSelectedCount = 0
  let FallbackCount = 0

  for (let WindowStart = 0; WindowStart < AllWork.length && WorkItems.length < MaxCandidates; WindowStart += PrefetchSize) {
    const Window = AllWork.slice(WindowStart, WindowStart + PrefetchSize)

    for (const Batch of SplitIntoBatches(Window, UrlFilterBatchSize)) {
      if (WorkItems.length >= MaxCandidates) {
        break
      }

      ConsideredCount += Batch.length
      try {
        const UnusedDomains = new Set(await FindUnused({ Domains: Batch.map(Work => Work.SourceDomain) }))
        const Selected = Batch.filter(Work => UnusedDomains.has(Work.SourceDomain))
        UrlFilterSelectedCount += Selected.length
        WorkItems.push(...Selected.slice(0, MaxCandidates - WorkItems.length))
      } catch (Failure) {
        const Message = Failure instanceof Error ? Failure.message : String(Failure)
        Options.OnWarning?.(`URL Filter batch failed; using Globalping fallback for ${Batch.length} jobs: ${Message}`)
        FallbackCount += Batch.length
        WorkItems.push(...Batch.slice(0, MaxCandidates - WorkItems.length))
      }
    }
  }

  return { WorkItems, ConsideredCount, UrlFilterSelectedCount, FallbackCount }
}