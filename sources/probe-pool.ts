import * as Os from 'node:os'
import * as Process from 'node:process'
import { Piscina } from 'piscina'
import type { DomainProbeResult, ProbeWorkItem } from './types.ts'
import type { GlobalpingLocation } from './config.ts'
import type { ProbeWorkerData, ProbeWorkerResult, ProbeWorkerSharedData } from './probe-worker.ts'

export type ProbePoolOptions = {
  WorkItems: ProbeWorkItem[]
  ApiToken: string
  Locations: GlobalpingLocation[]
  Limit: number
  CheckedAt: number
  WorkerCount: number
  RunWorker?: ProbeRunner
}

export type ProbePoolResult = {
  ProbeResults: DomainProbeResult[]
  ProbeFailedDomains: Set<string>
  RateLimited: boolean
  RateLimitMessage: string | null
}

export type ProbeRunner = (Data: ProbeWorkerData) => Promise<ProbeWorkerResult>

export function GetDefaultWorkerCount(): number {
  return Math.max(1, Os.cpus().length)
}

export function NormalizeWorkerCount(WorkerCount: number): number {
  return Number.isInteger(WorkerCount) && WorkerCount > 0 ? WorkerCount : GetDefaultWorkerCount()
}

/** Locations/ApiToken/Limit/CheckedAt are the same for every task, so they are cloned once per
 *  pooled worker (Piscina `workerData`) instead of once per probed domain. */
function CreateProbePool(Shared: ProbeWorkerSharedData, WorkerCount: number): Piscina {
  return new Piscina({
    filename: new URL('./probe-worker.ts', import.meta.url).href,
    workerData: Shared,
    minThreads: WorkerCount,
    maxThreads: WorkerCount,
    execArgv: Process.execArgv
  })
}

function RunProbeWorker(Pool: Piscina): ProbeRunner {
  return Data => Pool.run({
    SourceDomain: Data.SourceDomain,
    Target: Data.Target,
    Protocol: Data.Protocol,
    PriorityKind: Data.PriorityKind
  })
}

function UnknownResult(WorkItem: ProbeWorkItem, ErrorValue: unknown): DomainProbeResult {
  return {
    Domain: WorkItem.SourceDomain,
    Target: WorkItem.Target,
    Protocol: WorkItem.Protocol,
    Verdict: 'Unknown',
    Reason: ErrorValue instanceof Error ? ErrorValue.message : String(ErrorValue),
    Warnings: [],
    SameDomainRedirects: [],
    ModifiedAtOverride: null,
    NextProbe: null
  }
}

export async function ProbeDomainsWithWorkers(Options: ProbePoolOptions): Promise<ProbePoolResult> {
  const WorkerCount = Math.min(NormalizeWorkerCount(Options.WorkerCount), Options.WorkItems.length)
  const Pool = Options.RunWorker
    ? null
    : CreateProbePool({ ApiToken: Options.ApiToken, Locations: Options.Locations, Limit: Options.Limit, CheckedAt: Options.CheckedAt }, WorkerCount)
  const RunWorker = Options.RunWorker ?? RunProbeWorker(Pool!)
  const ProbeResultsByIndex: Array<DomainProbeResult | undefined> = []
  const ProbeFailedDomains = new Set<string>()
  let NextIndex = 0
  let RateLimited = false
  let RateLimitMessage: string | null = null

  const RunNext = async (): Promise<void> => {
    for (;;) {
      if (RateLimited || NextIndex >= Options.WorkItems.length) {
        return
      }

      const CandidateIndex = NextIndex
      const WorkItem = Options.WorkItems[CandidateIndex]
      NextIndex += 1

      try {
        const WorkerResult = await RunWorker({
          SourceDomain: WorkItem.SourceDomain,
          Target: WorkItem.Target,
          Protocol: WorkItem.Protocol,
          PriorityKind: WorkItem.PriorityKind,
          ApiToken: Options.ApiToken,
          Locations: Options.Locations,
          Limit: Options.Limit,
          CheckedAt: Options.CheckedAt
        })

        if (WorkerResult.Type === 'RateLimited') {
          RateLimited = true
          RateLimitMessage = WorkerResult.Message
          return
        }

        if (WorkerResult.Type === 'ProbeFailed') {
          ProbeFailedDomains.add(WorkItem.SourceDomain)
        }

        ProbeResultsByIndex[CandidateIndex] = WorkerResult.Result
      } catch (ErrorValue) {
        ProbeFailedDomains.add(WorkItem.SourceDomain)
        ProbeResultsByIndex[CandidateIndex] = UnknownResult(WorkItem, ErrorValue)
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: WorkerCount }, () => RunNext()))
  } finally {
    await Pool?.destroy()
  }

  return {
    ProbeResults: ProbeResultsByIndex.filter(Result => Result !== undefined),
    ProbeFailedDomains,
    RateLimited,
    RateLimitMessage
  }
}