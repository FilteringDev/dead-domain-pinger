import { workerData } from 'piscina'
import type { GlobalpingLocation } from './config.ts'
import { GlobalpingRateLimitError, ProbeDomain } from './globalping.ts'
import type { ResolvedJudgementPreferences } from './judgement-policy.ts'
import { DetermineNextProbe } from './probe-transitions.ts'
import { EvaluateMeasurement } from './verdict.ts'
import type {
  DomainOrigin,
  DomainProbeResult,
  DomainVerdict,
  OriginJudgement,
  PriorityProbeKind,
  ProbeProtocol
} from './types.ts'

/** Constant for the whole probe run; cloned once per pooled worker instead of once per task. */
export type ProbeWorkerSharedData = {
  Locations: GlobalpingLocation[]
  Limit: number
  ApiToken: string
  CheckedAt: number
  JudgementPreferences: ResolvedJudgementPreferences
}

export type ProbeWorkerTask = {
  SourceDomain: string
  Target: string
  Protocol: ProbeProtocol
  PriorityKind: PriorityProbeKind | null
  Origins: DomainOrigin[]
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

function Summarize(Judgements: Partial<Record<DomainOrigin, OriginJudgement>>, Origins: DomainOrigin[]): {
  Verdict: DomainVerdict
  Reason: string
} {
  const Values = Origins.map(Origin => Judgements[Origin]).filter((Value): Value is OriginJudgement => Boolean(Value))
  const Dead = Values.find(Value => Value.Verdict === 'Dead')
  if (Dead) {
    return { Verdict: 'Dead', Reason: Dead.Reason }
  }

  if (Values.length > 0 && Values.every(Value => Value.Verdict === 'Alive')) {
    return { Verdict: 'Alive', Reason: Values[0].Reason }
  }

  return {
    Verdict: 'Unknown',
    Reason: Values.find(Value => Value.Verdict === 'Unknown')?.Reason ?? 'Origin judgements disagree'
  }
}

export function ProvisionalJudgements(
  Judgements: Partial<Record<DomainOrigin, OriginJudgement>>,
  Origins: DomainOrigin[],
  Target: string
): Partial<Record<DomainOrigin, OriginJudgement>> {
  return Object.fromEntries(Origins.map(Origin => {
    const Judgement = Judgements[Origin]
    if (!Judgement || Judgement.Verdict !== 'Dead') {
      return [Origin, Judgement]
    }

    return [Origin, {
      ...Judgement,
      Verdict: 'Unknown',
      Reason: 'Deletion postponed until queued follow-up probe of ' + Target + ' completes'
    }]
  }).filter((Entry): Entry is [DomainOrigin, OriginJudgement] => Boolean(Entry[1])))
}

function UnknownJudgements(Origins: DomainOrigin[], Reason: string): Partial<Record<DomainOrigin, OriginJudgement>> {
  return Object.fromEntries(Origins.map(Origin => [Origin, {
    Verdict: 'Unknown',
    Reason,
    Stage: null,
    RuleId: null
  }]))
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
    const Evaluation = EvaluateMeasurement(
      Data.Target,
      Measurement,
      Data.Origins,
      Data.JudgementPreferences
    )
    const HasDeadJudgement = Object.values(Evaluation.Judgements).some(Judgement => Judgement?.Verdict === 'Dead')
    const NextProbe = HasDeadJudgement ? DetermineNextProbe(Data, Evaluation.FailureKind) : null
    const Judgements = NextProbe
      ? ProvisionalJudgements(Evaluation.Judgements, Data.Origins, NextProbe.Target)
      : Evaluation.Judgements
    const Summary = Summarize(Judgements, Data.Origins)
    const ModifiedAtOverride = Evaluation.SameDomainRedirects.length > 0
      && Summary.Verdict !== 'Dead'
      && NextProbe === null
      ? Data.CheckedAt
      : null

    return {
      Type: 'Result',
      Result: {
        Domain: Data.SourceDomain,
        Target: Data.Target,
        Protocol: Data.Protocol,
        ...Summary,
        Warnings: NextProbe
          ? ['deletion postponed while an HTTP follow-up is pending']
          : Evaluation.Warnings,
        SameDomainRedirects: Evaluation.SameDomainRedirects,
        ModifiedAtOverride,
        NextProbe,
        Judgements,
        Provisional: NextProbe !== null
      }
    }
  } catch (ErrorValue) {
    if (ErrorValue instanceof GlobalpingRateLimitError) {
      return { Type: 'RateLimited', Message: FormatError(ErrorValue) }
    }

    const Reason = FormatError(ErrorValue)

    return {
      Type: 'ProbeFailed',
      Result: {
        Domain: Data.SourceDomain,
        Target: Data.Target,
        Protocol: Data.Protocol,
        Verdict: 'Unknown',
        Reason,
        Warnings: [],
        SameDomainRedirects: [],
        ModifiedAtOverride: null,
        NextProbe: null,
        Judgements: UnknownJudgements(Data.Origins, Reason),
        Provisional: false
      }
    }
  }
}

export default function ProbeWorkerHandler(Task: ProbeWorkerTask): Promise<ProbeWorkerResult> {
  return RunProbe({ ...Task, ...(workerData as ProbeWorkerSharedData) })
}
