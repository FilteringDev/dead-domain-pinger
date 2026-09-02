import { SelectProbeWork } from './candidate-selection.ts'
import { VerifyParkedDomains } from './obscura.ts'
import { FindUnusedDomains } from './urlfilter.ts'
import type { DomainCandidate, DomainProbeResult, ProbeWorkItem } from './types.ts'
import type { DeadDomainState } from './state.ts'

const UrlFilterBatchSize = 1000

export type SelectUrlFilteredProbeWorkOptions = {
  Candidates: DomainCandidate[]
  State: DeadDomainState
  MaxCandidates: number
  PrefetchMultiplier: number
  Obscura?: {
    BinaryPath: string
    Concurrency: number
    TimeoutSeconds: number
  }
  VerifyParkedDomains?: typeof VerifyParkedDomains
  FindUnusedDomains?: typeof FindUnusedDomains
  OnWarning?: (Message: string) => void
}

export type UrlFilteredProbeWork = {
  WorkItems: ProbeWorkItem[]
  DirectResults: DomainProbeResult[]
  SelectedDomains: string[]
  ConsideredCount: number
  ObscuraCheckedCount: number
  ObscuraParkingCount: number
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
    return { WorkItems: [], DirectResults: [], SelectedDomains: [], ConsideredCount: 0, ObscuraCheckedCount: 0, ObscuraParkingCount: 0, UrlFilterSelectedCount: 0, FallbackCount: 0 }
  }

  const PrefetchSize = Math.max(MaxCandidates, MaxCandidates * Options.PrefetchMultiplier)
  const AllWork = SelectProbeWork(Options.Candidates, Options.State, Options.Candidates.length)
  const FindUnused = Options.FindUnusedDomains ?? FindUnusedDomains
  const WorkItems: ProbeWorkItem[] = []
  const DirectResults: DomainProbeResult[] = []
  let ConsideredCount = 0
  let ObscuraCheckedCount = 0
  let ObscuraParkingCount = 0
  let UrlFilterSelectedCount = 0
  let FallbackCount = 0

  for (let WindowStart = 0; WindowStart < AllWork.length && WorkItems.length + DirectResults.length < MaxCandidates; WindowStart += PrefetchSize) {
    const Window = AllWork.slice(WindowStart, WindowStart + PrefetchSize)
    const DirectResultsByDomain = new Map<string, DomainProbeResult>()

    if (Options.Obscura) {
      const Verify = Options.VerifyParkedDomains ?? VerifyParkedDomains
      const WindowDirectResults = await Verify({ WorkItems: Window, ...Options.Obscura })
      ObscuraCheckedCount += Window.length
      for (const Result of WindowDirectResults) {
        DirectResultsByDomain.set(Result.Domain, Result)
      }
    }

    for (const Batch of SplitIntoBatches(Window, UrlFilterBatchSize)) {
      if (WorkItems.length + DirectResults.length >= MaxCandidates) {
        break
      }

      const RemainingCapacity = MaxCandidates - WorkItems.length - DirectResults.length
      const DirectBatchResults = Batch
        .map(Work => DirectResultsByDomain.get(Work.SourceDomain))
        .filter((Result): Result is DomainProbeResult => Boolean(Result))
      const IncludedDirectResults = DirectBatchResults.slice(0, RemainingCapacity)
      DirectResults.push(...IncludedDirectResults)
      ObscuraParkingCount += IncludedDirectResults.length
      const RemainingBatch = Batch.filter(Work => !DirectResultsByDomain.has(Work.SourceDomain))
      if (RemainingBatch.length === 0 || WorkItems.length + DirectResults.length >= MaxCandidates) {
        continue
      }

      ConsideredCount += RemainingBatch.length
      try {
        const UnusedDomains = new Set(await FindUnused({ Domains: RemainingBatch.map(Work => Work.SourceDomain) }))
        const Selected = RemainingBatch.filter(Work => UnusedDomains.has(Work.SourceDomain))
        UrlFilterSelectedCount += Selected.length
        WorkItems.push(...Selected.slice(0, MaxCandidates - WorkItems.length - DirectResults.length))
      } catch (Failure) {
        const Message = Failure instanceof Error ? Failure.message : String(Failure)
        Options.OnWarning?.(`URL Filter batch failed; using Globalping fallback for ${RemainingBatch.length} jobs: ${Message}`)
        FallbackCount += RemainingBatch.length
        WorkItems.push(...RemainingBatch.slice(0, MaxCandidates - WorkItems.length - DirectResults.length))
      }
    }
  }

  const SelectedDomainSet = new Set([...DirectResults.map(Result => Result.Domain), ...WorkItems.map(Work => Work.SourceDomain)])
  return {
    WorkItems,
    DirectResults,
    SelectedDomains: AllWork.filter(Work => SelectedDomainSet.has(Work.SourceDomain)).map(Work => Work.SourceDomain),
    ConsideredCount,
    ObscuraCheckedCount,
    ObscuraParkingCount,
    UrlFilterSelectedCount,
    FallbackCount
  }
}