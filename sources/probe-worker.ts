import { parentPort, workerData } from 'node:worker_threads'
import { GlobalpingRateLimitError, ProbeDomain } from './globalping.ts'
import { EvaluateMeasurement } from './verdict.ts'
import type { DomainProbeResult } from './types.ts'

export type ProbeWorkerData = {
  Domain: string
  ApiToken?: string
  CheckedAt: number
}

export type ProbeWorkerResult = {
  Type: 'Result'
  Result: DomainProbeResult
} | {
  Type: 'ProbeFailed'
  Result: DomainProbeResult
} | {
  Type: 'RateLimited'
  Message: string
}

function FormatError(ErrorValue: unknown): string {
  return ErrorValue instanceof Error ? ErrorValue.message : String(ErrorValue)
}

async function RunProbe(Data: ProbeWorkerData): Promise<ProbeWorkerResult> {
  try {
    const Measurement = await ProbeDomain(Data.Domain, Data.ApiToken)
    const { Verdict, Reason, Warnings, SameDomainRedirects } = EvaluateMeasurement(Data.Domain, Measurement)
    const ModifiedAtOverride = SameDomainRedirects.length > 0 && Verdict !== 'Dead' ? Data.CheckedAt : null

    return {
      Type: 'Result',
      Result: { Domain: Data.Domain, Verdict, Reason, Warnings, SameDomainRedirects, ModifiedAtOverride }
    }
  } catch (ErrorValue) {
    if (ErrorValue instanceof GlobalpingRateLimitError) {
      return { Type: 'RateLimited', Message: FormatError(ErrorValue) }
    }

    return {
      Type: 'ProbeFailed',
      Result: {
        Domain: Data.Domain,
        Verdict: 'Unknown',
        Reason: FormatError(ErrorValue),
        Warnings: [],
        SameDomainRedirects: [],
        ModifiedAtOverride: null
      }
    }
  }
}

if (!parentPort) {
  throw new Error('probe-worker must run in a worker thread')
}

parentPort.postMessage(await RunProbe(workerData as ProbeWorkerData))