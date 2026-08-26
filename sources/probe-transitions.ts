import { IsRegistrableDomainRoot } from './verdict.ts'
import type { PendingProbe, PriorityProbeKind, ProbeProtocol } from './types.ts'

export type ProbeTransitionInput = {
  SourceDomain: string
  Protocol: ProbeProtocol
  PriorityKind: PriorityProbeKind | null
}

export function DetermineNextProbe(Data: ProbeTransitionInput, FailureKind: 'Dns' | 'Tls' | null): PendingProbe | null {
  if (FailureKind === null) {
    return null
  }

  if (Data.PriorityKind === 'RetryOriginalHttp' && Data.Protocol === 'HTTP' && IsRegistrableDomainRoot(Data.SourceDomain)) {
    return { Target: `www.${Data.SourceDomain}`, Kind: 'TryWwwHttp' }
  }

  if (Data.PriorityKind === null && Data.Protocol === 'HTTPS' && (FailureKind === 'Tls' || IsRegistrableDomainRoot(Data.SourceDomain))) {
    return { Target: Data.SourceDomain, Kind: 'RetryOriginalHttp' }
  }

  return null
}