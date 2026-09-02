import { expect, test } from 'vitest'
import { SelectUrlFilteredProbeWork } from '../sources/urlfilter-selection.ts'
import { CreateEmptyState, QueuePendingProbe } from '../sources/state.ts'
import type { DomainCandidate } from '../sources/types.ts'

function Candidate(Domain: string): DomainCandidate {
  return {
    Domain,
    LatestModifiedAt: 0,
    LastCheckedAt: 0,
    ModifiedAtOverride: 0,
    SortKey: 0,
    Occurrences: [],
    Origins: ['domainList']
  }
}

test('URL Filter refills Globalping work from the next oldest candidate window', async () => {
  const Calls: string[][] = []
  const Result = await SelectUrlFilteredProbeWork({
    Candidates: ['oldest.example', 'older.example', 'newer.example'].map(Candidate),
    State: CreateEmptyState(),
    MaxCandidates: 2,
    PrefetchMultiplier: 1,
    FindUnusedDomains: ({ Domains }) => {
      Calls.push(Domains)
      return Promise.resolve(Domains.filter(Domain => Domain !== 'oldest.example'))
    }
  })

  expect(Calls).toEqual([
    ['oldest.example', 'older.example'],
    ['newer.example']
  ])
  expect(Result.WorkItems.map(Work => Work.SourceDomain)).toEqual(['older.example', 'newer.example'])
  expect(Result).toMatchObject({ ConsideredCount: 3, ObscuraCheckedCount: 0, ObscuraParkingCount: 0, UrlFilterSelectedCount: 2, FallbackCount: 0 })
})

test('URL Filter retains pending HTTP work order while preprocessing it', async () => {
  const State = CreateEmptyState()
  QueuePendingProbe(State, 'older.example', 'www.older.example', 'TryWwwHttp')

  const Result = await SelectUrlFilteredProbeWork({
    Candidates: ['oldest.example', 'older.example'].map(Candidate),
    State,
    MaxCandidates: 2,
    PrefetchMultiplier: 100,
    FindUnusedDomains: ({ Domains }) => Promise.resolve(Domains)
  })

  expect(Result.WorkItems).toEqual([
    { SourceDomain: 'older.example', Target: 'www.older.example', Protocol: 'HTTP', PriorityKind: 'TryWwwHttp', Origins: ['domainList'] },
    { SourceDomain: 'oldest.example', Target: 'oldest.example', Protocol: 'HTTPS', PriorityKind: null, Origins: ['domainList'] }
  ])
})

test('URL Filter failure falls back to Globalping without exceeding its quota', async () => {
  const Warnings: string[] = []
  const Result = await SelectUrlFilteredProbeWork({
    Candidates: ['oldest.example', 'older.example', 'newer.example'].map(Candidate),
    State: CreateEmptyState(),
    MaxCandidates: 2,
    PrefetchMultiplier: 100,
    FindUnusedDomains: () => Promise.reject(new Error('service unavailable')),
    OnWarning: Message => Warnings.push(Message)
  })

  expect(Result.WorkItems.map(Work => Work.SourceDomain)).toEqual(['oldest.example', 'older.example'])
  expect(Result).toMatchObject({ ConsideredCount: 3, ObscuraCheckedCount: 0, ObscuraParkingCount: 0, UrlFilterSelectedCount: 0, FallbackCount: 3 })
  expect(Warnings).toEqual(['URL Filter batch failed; using Globalping fallback for 3 jobs: service unavailable'])
})

test('Obscura parking results bypass URL Filter and Globalping within the shared quota', async () => {
  const Result = await SelectUrlFilteredProbeWork({
    Candidates: ['oldest.example', 'older.example'].map(Candidate),
    State: CreateEmptyState(),
    MaxCandidates: 2,
    PrefetchMultiplier: 100,
    Obscura: { BinaryPath: '/tmp/obscura', Concurrency: 10, TimeoutSeconds: 15 },
    VerifyParkedDomains: ({ WorkItems }) => Promise.resolve(WorkItems[0] ? [{
      Domain: WorkItems[0].SourceDomain,
      Target: WorkItems[0].Target,
      Protocol: WorkItems[0].Protocol,
      Verdict: 'Dead',
      Reason: 'parked',
      Warnings: [],
      SameDomainRedirects: [],
      ModifiedAtOverride: null,
      NextProbe: null,
      Judgements: { domainList: { Verdict: 'Dead', Reason: 'parked', Stage: 'Http', RuleId: 'obscura-parking-redirect' } },
      Provisional: false
    }] : []),
    FindUnusedDomains: ({ Domains }) => Promise.resolve(Domains)
  })

  expect(Result.DirectResults.map(Result => Result.Domain)).toEqual(['oldest.example'])
  expect(Result.WorkItems.map(Work => Work.SourceDomain)).toEqual(['older.example'])
  expect(Result).toMatchObject({ ObscuraCheckedCount: 2, ObscuraParkingCount: 1, ConsideredCount: 1 })
})