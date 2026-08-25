import test from 'node:test'
import assert from 'node:assert/strict'
import { BuildDomainCandidates } from '../sources/candidate-selection.ts'
import { CreateEmptyState, GetModifiedAtOverride, RecordVerdict } from '../sources/state.ts'
import type { DomainOccurrence } from '../sources/types.ts'

const Occurrences: DomainOccurrence[] = [
  { Domain: 'old.example', FilePath: 'a.txt', LineNumber: 1 },
  { Domain: 'redirected.example', FilePath: 'a.txt', LineNumber: 2 }
]

test('RecordVerdict persists a modification date override', () => {
  const State = CreateEmptyState()
  RecordVerdict(State, 'redirected.example', 'Unknown', 1000, [], 1000)

  assert.equal(GetModifiedAtOverride(State, 'redirected.example'), 1000)
})

test('RecordVerdict carries a previous override forward', () => {
  const State = CreateEmptyState()
  RecordVerdict(State, 'redirected.example', 'Unknown', 1000, [], 1000)
  RecordVerdict(State, 'redirected.example', 'Alive', 2000, [])

  assert.equal(State.Domains['redirected.example'].LastCheckedAt, 2000)
  assert.equal(GetModifiedAtOverride(State, 'redirected.example'), 1000)
})

test('RecordVerdict stores no override when none was ever recorded', () => {
  const State = CreateEmptyState()
  RecordVerdict(State, 'old.example', 'Alive', 2000, [])

  assert.equal('ModifiedAtOverride' in State.Domains['old.example'], false)
})

test('An override pushes a domain to the back of the queue', () => {
  const State = CreateEmptyState()
  RecordVerdict(State, 'redirected.example', 'Unknown', 500, [], 9000)

  const Candidates = BuildDomainCandidates({
    // Outside a git repository blame yields nothing, so every line uses the fallback time.
    WorkingDirectory: '/',
    Occurrences,
    State,
    FallbackAuthorTime: 1000
  })

  assert.deepEqual(Candidates.map(Candidate => Candidate.Domain), ['old.example', 'redirected.example'])
  assert.equal(Candidates[1].SortKey, 9000)
})
