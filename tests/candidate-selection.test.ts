import test from 'node:test'
import assert from 'node:assert/strict'
import { SelectProbeWork } from '../sources/candidate-selection.ts'
import { CreateEmptyState, QueuePendingProbe } from '../sources/state.ts'
import type { DomainCandidate } from '../sources/types.ts'

function Candidate(Domain: string): DomainCandidate {
  return {
    Domain,
    LatestModifiedAt: 0,
    LastCheckedAt: 0,
    ModifiedAtOverride: 0,
    SortKey: 0,
    Occurrences: []
  }
}

test('pending HTTP work takes priority and replaces the normal HTTPS work for its source domain', () => {
  const State = CreateEmptyState()
  QueuePendingProbe(State, 'b.example', 'www.b.example', 'TryWwwHttp')

  assert.deepEqual(SelectProbeWork([Candidate('a.example'), Candidate('b.example')], State, 3), [
    { SourceDomain: 'b.example', Target: 'www.b.example', Protocol: 'HTTP', PriorityKind: 'TryWwwHttp' },
    { SourceDomain: 'a.example', Target: 'a.example', Protocol: 'HTTPS', PriorityKind: null }
  ])
})

test('priority work consumes the same candidate limit as normal work', () => {
  const State = CreateEmptyState()
  QueuePendingProbe(State, 'a.example', 'a.example', 'RetryOriginalHttp')

  assert.deepEqual(SelectProbeWork([Candidate('a.example'), Candidate('b.example')], State, 1), [
    { SourceDomain: 'a.example', Target: 'a.example', Protocol: 'HTTP', PriorityKind: 'RetryOriginalHttp' }
  ])
})