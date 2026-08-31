export type DomainOccurrence = {
  Domain: string
  FilePath: string
  LineNumber: number
  Origin: DomainOrigin
}

export type DomainOrigin = 'networkPattern' | 'domainList'

export const DomainOrigins: DomainOrigin[] = ['networkPattern', 'domainList']

export type DomainCandidate = {
  Domain: string
  LatestModifiedAt: number
  LastCheckedAt: number
  /** Replaces the git history date once a same-domain redirect has been detected. */
  ModifiedAtOverride: number
  SortKey: number
  Occurrences: DomainOccurrence[]
  Origins: DomainOrigin[]
}

export type ProbeProtocol = 'HTTP' | 'HTTPS'

export type PriorityProbeKind = 'RetryOriginalHttp' | 'TryWwwHttp'

export type ProbeWorkItem = {
  SourceDomain: string
  Target: string
  Protocol: ProbeProtocol
  PriorityKind: PriorityProbeKind | null
  Origins: DomainOrigin[]
}

export type PendingProbe = {
  Target: string
  Kind: PriorityProbeKind
}

export type DomainVerdict = 'Alive' | 'Dead' | 'Unknown'

export type OriginJudgement = {
  Verdict: DomainVerdict
  Reason: string
  Stage: 'Dns' | 'Http' | 'Body' | null
  RuleId: string | null
}

export type DomainProbeResult = {
  Domain: string
  Target: string
  Protocol: ProbeProtocol
  Verdict: DomainVerdict
  Reason: string
  Warnings: string[]
  SameDomainRedirects: string[]
  ModifiedAtOverride: number | null
  NextProbe: PendingProbe | null
  Judgements: Partial<Record<DomainOrigin, OriginJudgement>>
  Provisional: boolean
}

export type DomainRemovalTrigger = {
  Domain: string
  Origin: DomainOrigin
}

export type RuleChange = {
  FilePath: string
  LineNumber: number
  Before: string
  After: string | null
  RemovedDomains: string[]
  Triggers: DomainRemovalTrigger[]
}

export type FileRewriteResult = {
  Content: string
  Changed: boolean
  ModifiedRules: RuleChange[]
  RemovedRules: RuleChange[]
}
