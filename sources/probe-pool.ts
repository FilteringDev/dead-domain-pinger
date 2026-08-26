import * as Os from 'node:os'
import * as Process from 'node:process'
import { Worker } from 'node:worker_threads'
import type { DomainProbeResult, ProbeWorkItem } from './types.ts'
import type { GlobalpingLocation } from './config.ts'
import type { ProbeWorkerData, ProbeWorkerResult } from './probe-worker.ts'

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

function RunProbeWorker(Data: ProbeWorkerData): Promise<ProbeWorkerResult> {
  return new Promise((Resolve, Reject) => {
    const WorkerThread = new Worker(new URL('./probe-worker.ts', import.meta.url), {
      workerData: Data,
      execArgv: Process.execArgv
    })

    WorkerThread.once('message', Message => Resolve(Message as ProbeWorkerResult))
    WorkerThread.once('error', Reject)
    WorkerThread.once('exit', ExitCode => {
      if (ExitCode !== 0) {
        Reject(new Error(`Probe worker exited with code ${ExitCode}`))
      }
    })
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
  const RunWorker = Options.RunWorker ?? RunProbeWorker
  const WorkerCount = Math.min(NormalizeWorkerCount(Options.WorkerCount), Options.WorkItems.length)
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

  await Promise.all(Array.from({ length: WorkerCount }, () => RunNext()))

  return {
    ProbeResults: ProbeResultsByIndex.filter(Result => Result !== undefined),
    ProbeFailedDomains,
    RateLimited,
    RateLimitMessage
  }
}