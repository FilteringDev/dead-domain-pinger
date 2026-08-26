import { workerData } from 'piscina'
import type { GlobalpingLocation } from './config.ts'
import { GlobalpingRateLimitError, ProbeDomain } from './globalping.ts'
import { DetermineNextProbe } from './probe-transitions.ts'
import { EvaluateMeasurement } from './verdict.ts'
import type { DomainProbeResult, PriorityProbeKind, ProbeProtocol } from './types.ts'

/** Constant for the whole probe run; cloned once per pooled worker instead of once per task. */
export type ProbeWorkerSharedData = {
  Locations: GlobalpingLocation[]
  Limit: number
  ApiToken: string
  CheckedAt: number
}

export type ProbeWorkerTask = {
  SourceDomain: string
  Target: string
  Protocol: ProbeProtocol
  PriorityKind: PriorityProbeKind | null
}

export type ProbeWorkerData = ProbeWorkerTask & ProbeWorkerSharedData

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
    const Measurement = await ProbeDomain({
      Target: Data.Target,
      Protocol: Data.Protocol,
      Locations: Data.Locations,
      Limit: Data.Limit,
      ApiToken: Data.ApiToken
    })
    const { Verdict, Reason, Warnings, SameDomainRedirects, FailureKind } = EvaluateMeasurement(Data.Target, Measurement)
    const ModifiedAtOverride = SameDomainRedirects.length > 0 && Verdict !== 'Dead' ? Data.CheckedAt : null

    return {
      Type: 'Result',
      Result: {
        Domain: Data.SourceDomain,
        Target: Data.Target,
        Protocol: Data.Protocol,
        Verdict,
        Reason,
        Warnings,
        SameDomainRedirects,
        ModifiedAtOverride,
        NextProbe: DetermineNextProbe(Data, FailureKind)
      }
    }
  } catch (ErrorValue) {
    if (ErrorValue instanceof GlobalpingRateLimitError) {
      return { Type: 'RateLimited', Message: FormatError(ErrorValue) }
    }

    return {
      Type: 'ProbeFailed',
      Result: {
        Domain: Data.SourceDomain,
        Target: Data.Target,
        Protocol: Data.Protocol,
        Verdict: 'Unknown',
        Reason: FormatError(ErrorValue),
        Warnings: [],
        SameDomainRedirects: [],
        ModifiedAtOverride: null,
        NextProbe: null
      }
    }
  }
}

export default function ProbeWorkerHandler(Task: ProbeWorkerTask): Promise<ProbeWorkerResult> {
  return RunProbe({ ...Task, ...(workerData as ProbeWorkerSharedData) })
}