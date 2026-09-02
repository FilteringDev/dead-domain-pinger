import { expect, test } from 'vitest'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { BuildDomainCandidates } from '../sources/candidate-selection.ts'
import { ClearPendingProbe, CreateEmptyState, GetModifiedAtOverride, GetPendingProbe, LoadState, QueuePendingProbe, RecordVerdict, SaveState, StateFileName } from '../sources/state.ts'
import type { DomainOccurrence } from '../sources/types.ts'

const Occurrences: DomainOccurrence[] = [
  { Domain: 'old.example', FilePath: 'a.txt', LineNumber: 1, Origin: 'domainList' },
  { Domain: 'redirected.example', FilePath: 'a.txt', LineNumber: 2, Origin: 'domainList' }
]

test('RecordVerdict persists a modification date override', () => {
  const State = CreateEmptyState()
  RecordVerdict(State, 'redirected.example', 'Unknown', 1000, [], 1000)

  expect(GetModifiedAtOverride(State, 'redirected.example')).toBe(1000)
})

test('RecordVerdict carries a previous override forward', () => {
  const State = CreateEmptyState()
  RecordVerdict(State, 'redirected.example', 'Unknown', 1000, [], 1000)
  RecordVerdict(State, 'redirected.example', 'Alive', 2000, [])

  expect(State.Domains['redirected.example'].LastCheckedAt).toBe(2000)
  expect(GetModifiedAtOverride(State, 'redirected.example')).toBe(1000)
})

test('RecordVerdict stores no override when none was ever recorded', () => {
  const State = CreateEmptyState()
  RecordVerdict(State, 'old.example', 'Alive', 2000, [])

  expect('ModifiedAtOverride' in State.Domains['old.example']).toBe(false)
})

test('pending probes can be queued and cleared independently from verdicts', () => {
  const State = CreateEmptyState()
  QueuePendingProbe(State, 'example.com', 'www.example.com', 'TryWwwHttp')

  expect(GetPendingProbe(State, 'example.com')).toEqual({ Target: 'www.example.com', Kind: 'TryWwwHttp' })
  ClearPendingProbe(State, 'example.com')
  expect(GetPendingProbe(State, 'example.com')).toBe(null)
})

test('An override pushes a domain to the back of the queue', async () => {
  const State = CreateEmptyState()
  RecordVerdict(State, 'redirected.example', 'Unknown', 500, [], 9000)

  const Candidates = await BuildDomainCandidates({
    // Outside a git repository blame yields nothing, so every line uses the fallback time.
    WorkingDirectory: '/',
    Occurrences,
    State,
    FallbackAuthorTime: 1000
  })

  expect(Candidates.map(Candidate => Candidate.Domain)).toEqual(['old.example', 'redirected.example'])
  expect(Candidates[1].SortKey).toBe(9000)
})

test('SQLite state persists a pruned state round trip', async () => {
  const StateDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-state-'))
  const StateFilePath = Path.join(StateDirectory, StateFileName)
  const State = CreateEmptyState()
  RecordVerdict(State, 'kept.example', 'Dead', 2000, ['warning'], 3000)
  RecordVerdict(State, 'removed.example', 'Alive', 1000, [])
  QueuePendingProbe(State, 'kept.example', 'kept.example', 'RetryOriginalHttp')
  QueuePendingProbe(State, 'removed.example', 'www.removed.example', 'TryWwwHttp')

  await SaveState(StateFilePath, State, new Set(['kept.example']))
  const LoadedState = await LoadState(StateFilePath)

  expect(Object.keys(LoadedState.Domains)).toEqual(['kept.example'])
  expect(LoadedState.Domains['kept.example']).toEqual({
    LastCheckedAt: 2000,
    LastVerdict: 'Dead',
    LastWarnings: ['warning'],
    ModifiedAtOverride: 3000
  })
  expect(LoadedState.PendingProbes).toEqual({
    'kept.example': { Target: 'kept.example', Kind: 'RetryOriginalHttp' }
  })
})

test('SQLite state falls back to empty when missing', async () => {
  const StateDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-state-'))
  const LoadedState = await LoadState(Path.join(StateDirectory, StateFileName))

  expect(LoadedState).toEqual(CreateEmptyState())
})

test('SQLite state persists and prunes Git ordering cache entries', async () => {
  const StateDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-state-'))
  const StateFilePath = Path.join(StateDirectory, StateFileName)
  const State = CreateEmptyState()
  State.GitOrderCache = [
    { FilePath: 'filters.txt', Revision: 'a'.repeat(40), LineNumber: 1, Domain: 'kept.example', ModifiedAt: 1000 },
    { FilePath: 'filters.txt', Revision: 'a'.repeat(40), LineNumber: 2, Domain: 'removed.example', ModifiedAt: 2000 }
  ]

  await SaveState(StateFilePath, State, new Set(['kept.example']))

  await expect(LoadState(StateFilePath)).resolves.toMatchObject({
    GitOrderCache: [{
      FilePath: 'filters.txt',
      Revision: 'a'.repeat(40),
      LineNumber: 1,
      Domain: 'kept.example',
      ModifiedAt: 1000
    }]
  })
})

test('SQLite state falls back to empty when corrupt', async () => {
  const StateDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-state-'))
  const StateFilePath = Path.join(StateDirectory, StateFileName)
  Fs.writeFileSync(StateFilePath, 'not sqlite', 'utf-8')

  const LoadedState = await LoadState(StateFilePath)

  expect(LoadedState).toEqual(CreateEmptyState())
})

test('a policy fingerprint change invalidates verdict ages and pending retries', async () => {
  const StateDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-state-'))
  const StateFilePath = Path.join(StateDirectory, StateFileName)
  const State = CreateEmptyState('old-policy')
  RecordVerdict(State, 'example.com', 'Dead', 2000, ['warning'])
  QueuePendingProbe(State, 'example.com', 'example.com', 'RetryOriginalHttp')

  await SaveState(StateFilePath, State, new Set(['example.com']))

  const Matching = await LoadState(StateFilePath, 'old-policy')
  expect(Matching.PolicyFingerprint).toBe('old-policy')
  expect(Matching.Domains['example.com'].LastCheckedAt).toBe(2000)
  expect(Matching.PendingProbes['example.com']).toBeDefined()

  const Invalidated = await LoadState(StateFilePath, 'new-policy')
  expect(Invalidated).toEqual(CreateEmptyState('new-policy'))
})
