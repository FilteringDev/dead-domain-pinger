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
  expect(Result).toMatchObject({ ConsideredCount: 3, UrlFilterSelectedCount: 2, FallbackCount: 0 })
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
  expect(Result).toMatchObject({ ConsideredCount: 3, UrlFilterSelectedCount: 0, FallbackCount: 3 })
  expect(Warnings).toEqual(['URL Filter batch failed; using Globalping fallback for 3 jobs: service unavailable'])
})