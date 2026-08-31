import { registrableDomain } from '@structured-world/structured-public-domains'
import type { GlobalpingMeasurement, GlobalpingProbeResult } from './globalping.ts'
import {
  DefaultJudgementPreferences,
  type BodyMatcher,
  type JudgementCondition,
  type JudgementRule,
  type JudgementStage,
  type ResolvedJudgementPreferences,
  type StatusCodeSelector
} from './judgement-policy.ts'
import { GetParkingBodyProviders, IsParkingServiceHost } from './parking-services.ts'
import { EvaluateJudgementPolicy } from './policy-evaluator.ts'
import { DomainOrigins, type DomainOrigin, type DomainVerdict, type OriginJudgement } from './types.ts'

const MaximumInspectedBodyLength = 10 * 1024

// Name resolution failures reported by Globalping probes.
const DeadDnsPatterns = [
  /\bENOTFOUND\b/i,
  /\bEAI_NONAME\b/i,
  /\bNXDOMAIN\b/i,
  /\bno\s+name\b/i,
  /\bname\s+or\s+service\s+not\s+known\b/i,
  /\bcould\s+not\s+resolve\b/i,
  /\bresolution\s+failed\b/i
]

const AliveTimeoutPatterns = [
  /\bETIMEDOUT\b/i,
  /\bESOCKETTIMEDOUT\b/i,
  /\btimeout\b/i,
  /\btimed\s+out\b/i
]

const TlsFailurePatterns = [
  /\b(?:TLS|SSL)\s+handshake\b/i,
  /\bEPROTO\b/i,
  /\bERR_SSL_[A-Z_]+\b/i,
  /\bCERT_HAS_EXPIRED\b/i,
  /\bCERT_NOT_YET_VALID\b/i,
  /\bDEPTH_ZERO_SELF_SIGNED_CERT\b/i,
  /\bSELF_SIGNED_CERT_IN_CHAIN\b/i,
  /\bUNABLE_TO_VERIFY_LEAF_SIGNATURE\b/i,
  /\bUNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?\b/i,
  /\bERR_TLS_CERT_ALTNAME_INVALID\b/i,
  /\bHOSTNAME_MISMATCH\b/i
]

export type MeasurementEvaluation = {
  Verdict: DomainVerdict
  Reason: string
  Warnings: string[]
  /** Redirect targets sharing the probed domain's registrable domain. */
  SameDomainRedirects: string[]
  FailureKind: 'Dns' | 'Tls' | null
  Judgements: Partial<Record<DomainOrigin, OriginJudgement>>
}

export function NormalizeHost(Host: string): string {
  return Host.trim().toLowerCase().replace(/\.$/, '')
}

/** subdomains sharing one registrable domain are related; different registrable domains are not. */
export function AreDomainsRelated(Left: string, Right: string): boolean {
  const A = NormalizeHost(Left)
  const B = NormalizeHost(Right)

  if (A === B) {
    return true
  }

  const RegistrableA = registrableDomain(A)
  const RegistrableB = registrableDomain(B)

  // Hosts outside the public suffix list fall back to a plain sub-domain check.
  if (!RegistrableA || !RegistrableB) {
    return A.endsWith('.' + B) || B.endsWith('.' + A)
  }

  return RegistrableA === RegistrableB
}

function GetProbeOutput(Result: GlobalpingProbeResult): string {
  return [Result.rawOutput ?? '', Result.rawHeaders ?? ''].join('\n')
}

function GetHeaderValue(Result: GlobalpingProbeResult, HeaderName: string): string | null {
  for (const [Key, Value] of Object.entries(Result.headers ?? {})) {
    if (Key.toLowerCase() !== HeaderName) {
      continue
    }

    const Resolved = Array.isArray(Value) ? Value[0] : Value

    return Resolved ? String(Resolved) : null
  }

  return null
}

export function GetRedirectTargetHost(Domain: string, Result: GlobalpingProbeResult): string | null {
  const Location = GetHeaderValue(Result, 'location')
  if (!Location) {
    return null
  }

  try {
    return NormalizeHost(new URL(Location, 'https://' + Domain + '/').hostname)
  } catch {
    return null
  }
}

function IsTimeout(Result: GlobalpingProbeResult): boolean {
  return AliveTimeoutPatterns.some(Pattern => Pattern.test(GetProbeOutput(Result)))
}

function IsDnsFailure(Result: GlobalpingProbeResult): boolean {
  if (Result.resolvedAddress) {
    return false
  }

  return DeadDnsPatterns.some(Pattern => Pattern.test(GetProbeOutput(Result)))
}

/** A TLS connection that was established but failed certificate validation. */
export function IsTlsValidationFailure(Result: GlobalpingProbeResult): boolean {
  if (Result.tls && Result.tls.authorized === false) {
    return true
  }

  return TlsFailurePatterns.some(Pattern => Pattern.test(GetProbeOutput(Result)))
}

export function IsRegistrableDomainRoot(Domain: string): boolean {
  const Normalized = NormalizeHost(Domain)

  return registrableDomain(Normalized) === Normalized
}

function GetTlsFailureDetail(Result: GlobalpingProbeResult): string {
  return Result.tls?.error ?? Result.tls?.authorizationError ?? 'certificate validation failed'
}

function GetBody(Result: GlobalpingProbeResult): string {
  return (Result.rawBody ?? '').slice(0, MaximumInspectedBodyLength)
}

function CompileBodyMatchers(Matchers: Record<string, BodyMatcher>): Record<string, (Body: string) => boolean> {
  return Object.fromEntries(Object.entries(Matchers).map(([Id, Matcher]) => {
    if (Matcher.Kind === 'Literal') {
      const Expected = Matcher.CaseSensitive ? Matcher.Value : Matcher.Value.toLowerCase()

      return [Id, (Body: string) => {
        const Compared = Matcher.CaseSensitive ? Body : Body.toLowerCase()

        return Compared.includes(Expected)
      }]
    }

    const Pattern = new RegExp(Matcher.Pattern, Matcher.Flags)

    return [Id, (Body: string) => Pattern.test(Body)]
  }))
}

function StatusCodeMatches(StatusCode: number, Selector: StatusCodeSelector): boolean {
  if (typeof Selector === 'number') {
    return StatusCode === Selector
  }

  return Math.floor(StatusCode / 100) === Number(Selector[0])
}

function ResultMatchesCondition(
  Domain: string,
  Result: GlobalpingProbeResult,
  Condition: JudgementCondition,
  CompiledMatchers: Record<string, (Body: string) => boolean>
): boolean {
  const RedirectTarget = GetRedirectTargetHost(Domain, Result)

  switch (Condition.Signal) {
    case 'dnsResolved':
      return Boolean(Result.resolvedAddress)
    case 'dnsFailure':
      return IsDnsFailure(Result)
    case 'tlsValidationFailure':
      return IsTlsValidationFailure(Result)
    case 'timeout':
      return IsTimeout(Result)
    case 'redirect':
      return RedirectTarget !== null
    case 'parkingRedirect':
      return RedirectTarget !== null && IsParkingServiceHost(RedirectTarget)
    case 'foreignRedirect':
      return RedirectTarget !== null && !AreDomainsRelated(Domain, RedirectTarget)
    case 'sameDomainRedirect':
      return RedirectTarget !== null
        && NormalizeHost(Domain) !== RedirectTarget
        && AreDomainsRelated(Domain, RedirectTarget)
    case 'statusCode':
      return typeof Result.statusCode === 'number'
        && (Condition.Values ?? []).some(Value => StatusCodeMatches(Result.statusCode!, Value))
    case 'probeFailure':
      return Result.status === 'failed'
    case 'bodyPresent':
      return GetBody(Result).length > 0
    case 'bodyTruncated':
      return Result.truncated === true
    case 'parkingProvider': {
      const Providers = GetParkingBodyProviders(GetBody(Result))
      const Requested = Condition.Providers ?? Providers

      return Providers.some(Provider => Requested.includes(Provider))
    }
    case 'bodyMatcher':
      return Boolean(CompiledMatchers[Condition.Matcher ?? '']?.(GetBody(Result)))
  }
}

function ConditionMatches(
  Domain: string,
  Results: GlobalpingProbeResult[],
  Condition: JudgementCondition,
  CompiledMatchers: Record<string, (Body: string) => boolean>
): boolean {
  const MatchCount = Results.filter(Result => ResultMatchesCondition(Domain, Result, Condition, CompiledMatchers)).length
  const RatioMatches = Condition.MinimumRatio === null || MatchCount / Results.length >= Condition.MinimumRatio

  return MatchCount >= Condition.MinimumMatches && RatioMatches
}

function BuildRuleReason(
  Rule: JudgementRule,
  Stage: JudgementStage,
  Results: GlobalpingProbeResult[],
  ParkingRedirectTargets: string[],
  ForeignRedirectTargets: string[]
): string {
  switch (Rule.Id) {
    case 'default-dns-failure':
      return 'DNS name resolution failed on every probe'
    case 'default-tls-failure':
      return 'TLS certificate validation failed on every probe (' + GetTlsFailureDetail(Results[0]) + ')'
    case 'default-parking-redirect':
      return 'Redirects to a parking service (' + ParkingRedirectTargets.join(', ') + ')'
    case 'default-foreign-redirect':
      return 'Redirects to a different registrable domain (' + ForeignRedirectTargets.join(', ') + ')'
    case 'default-http-success':
      return 'HTTP 2xx response'
    case 'default-timeout':
      return 'HTTP request timed out'
    default:
      return 'Judgement rule ' + Rule.Id + ' matched in the ' + Stage + ' stage'
  }
}

function SummarizeJudgements(
  Origins: DomainOrigin[],
  Judgements: Partial<Record<DomainOrigin, OriginJudgement>>
): { Verdict: DomainVerdict, Reason: string } {
  const Values = Origins.map(Origin => Judgements[Origin]).filter((Value): Value is OriginJudgement => Boolean(Value))
  const Dead = Values.find(Value => Value.Verdict === 'Dead')
  if (Dead) {
    return { Verdict: 'Dead', Reason: Dead.Reason }
  }

  if (Values.length > 0 && Values.every(Value => Value.Verdict === 'Alive')) {
    return { Verdict: 'Alive', Reason: Values[0].Reason }
  }

  const Unknown = Values.find(Value => Value.Verdict === 'Unknown')

  return { Verdict: 'Unknown', Reason: Unknown?.Reason ?? 'Origin judgements disagree' }
}

function BuildWarnings(
  Judgements: Partial<Record<DomainOrigin, OriginJudgement>>,
  Results: GlobalpingProbeResult[],
  ParkingRedirectTargets: string[],
  ForeignRedirectTargets: string[]
): string[] {
  const Warnings = new Set<string>()

  for (const [Origin, Judgement] of Object.entries(Judgements) as [DomainOrigin, OriginJudgement][]) {
    if (Judgement.Verdict !== 'Dead') {
      continue
    }

    if (Judgement.RuleId === 'default-tls-failure') {
      Warnings.add('removed because TLS certificate validation failed (' + GetTlsFailureDetail(Results[0]) + ') — the host may still be reachable over plain HTTP')
    } else if (Judgement.RuleId === 'default-parking-redirect') {
      Warnings.add('removed because it redirects to a known parking service (' + ParkingRedirectTargets.join(', ') + ')')
    } else if (Judgement.RuleId === 'default-foreign-redirect') {
      Warnings.add('removed because it redirects to ' + ForeignRedirectTargets.join(', ') + ' — if this is an intentional rebrand, add rules for the new domain')
    } else {
      Warnings.add(Origin + ' judged dead by policy rule ' + (Judgement.RuleId ?? 'fallback'))
    }
  }

  return [...Warnings]
}

/** Evaluates one Globalping HTTP measurement independently for every observed AGTree origin. */
export function EvaluateMeasurement(
  Domain: string,
  Measurement: GlobalpingMeasurement,
  Origins: DomainOrigin[] = [DomainOrigins[0]],
  Preferences: ResolvedJudgementPreferences = DefaultJudgementPreferences
): MeasurementEvaluation {
  const Results = Measurement.results.map(Entry => Entry.result)
  const SameDomainRedirects: string[] = []
  const Judgements: Partial<Record<DomainOrigin, OriginJudgement>> = {}

  if (Results.length === 0) {
    for (const Origin of Origins) {
      Judgements[Origin] = {
        Verdict: 'Unknown',
        Reason: 'No probe results were returned',
        Stage: null,
        RuleId: null
      }
    }

    return {
      Verdict: 'Unknown',
      Reason: 'No probe results were returned',
      Warnings: [],
      SameDomainRedirects,
      FailureKind: null,
      Judgements
    }
  }

  const RedirectTargets = Results
    .map(Result => GetRedirectTargetHost(Domain, Result))
    .filter((Host): Host is string => Host !== null)
  const ParkingRedirectTargets = [...new Set(RedirectTargets.filter(IsParkingServiceHost))]
  const ForeignRedirectTargets = [...new Set(RedirectTargets.filter(Target => !AreDomainsRelated(Domain, Target)))]

  for (const Target of new Set(RedirectTargets)) {
    if (AreDomainsRelated(Domain, Target) && NormalizeHost(Domain) !== Target) {
      SameDomainRedirects.push(Target)
    }
  }

  const CompiledMatchers = CompileBodyMatchers(Preferences.Matchers)

  for (const Origin of Origins) {
    const Policy = Preferences.Policies[Origin]
    const Judgement = EvaluateJudgementPolicy(
      Policy,
      Condition => ConditionMatches(Domain, Results, Condition, CompiledMatchers),
      (Rule, Stage) => BuildRuleReason(Rule, Stage, Results, ParkingRedirectTargets, ForeignRedirectTargets)
    )

    if (Judgement.RuleId === null) {
      const StatusCodes = Results.map(Result => Result.statusCode ?? 'n/a').join(', ')
      Judgement.Reason = 'Inconclusive probe outcome (status codes: ' + StatusCodes + ')'
    }

    Judgements[Origin] = Judgement
  }

  const Summary = SummarizeJudgements(Origins, Judgements)
  const FailureKind = Results.every(IsTlsValidationFailure)
    ? 'Tls'
    : Results.every(IsDnsFailure)
      ? 'Dns'
      : null

  return {
    ...Summary,
    Warnings: BuildWarnings(Judgements, Results, ParkingRedirectTargets, ForeignRedirectTargets),
    SameDomainRedirects,
    FailureKind,
    Judgements
  }
}
