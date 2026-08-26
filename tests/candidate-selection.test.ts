import test from 'node:test'
import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { simpleGit } from 'simple-git'
import { BuildDomainCandidates, SelectProbeWork } from '../sources/candidate-selection.ts'
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

test('BuildDomainCandidates keeps global Git ordering across parallel file workers', async () => {
  const WorkingDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-candidates-'))
  const Git = simpleGit({ baseDir: WorkingDirectory })
  await Git.init(['--quiet', '--initial-branch=main'])
  await Git.addConfig('user.email', 'test@example.com')
  await Git.addConfig('user.name', 'Test')

  Fs.writeFileSync(Path.join(WorkingDirectory, 'older.txt'), '||ads.example^$domain=older.example\n')
  await Git.env({ GIT_AUTHOR_DATE: '@1000 +0000', GIT_COMMITTER_DATE: '@1000 +0000' }).add('--all')
  await Git.env({ GIT_AUTHOR_DATE: '@1000 +0000', GIT_COMMITTER_DATE: '@1000 +0000' }).commit('Add older', ['--quiet'])

  Fs.writeFileSync(Path.join(WorkingDirectory, 'newer.txt'), '||ads.example^$domain=newer.example\n')
  await Git.env({ GIT_AUTHOR_DATE: '@2000 +0000', GIT_COMMITTER_DATE: '@2000 +0000' }).add('--all')
  await Git.env({ GIT_AUTHOR_DATE: '@2000 +0000', GIT_COMMITTER_DATE: '@2000 +0000' }).commit('Add newer', ['--quiet'])

  const Candidates = await BuildDomainCandidates({
    WorkingDirectory,
    Occurrences: [
      { Domain: 'older.example', FilePath: 'older.txt', LineNumber: 1 },
      { Domain: 'newer.example', FilePath: 'newer.txt', LineNumber: 1 }
    ],
    State: CreateEmptyState(),
    FallbackAuthorTime: 9000,
    WorkerCount: 2
  })

  assert.deepEqual(Candidates.map(Candidate => Candidate.Domain), ['older.example', 'newer.example'])
})