import { expect, test } from 'vitest'
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

  expect(SelectProbeWork([Candidate('a.example'), Candidate('b.example')], State, 3)).toEqual([
    { SourceDomain: 'b.example', Target: 'www.b.example', Protocol: 'HTTP', PriorityKind: 'TryWwwHttp' },
    { SourceDomain: 'a.example', Target: 'a.example', Protocol: 'HTTPS', PriorityKind: null }
  ])
})

test('priority work consumes the same candidate limit as normal work', () => {
  const State = CreateEmptyState()
  QueuePendingProbe(State, 'a.example', 'a.example', 'RetryOriginalHttp')

  expect(SelectProbeWork([Candidate('a.example'), Candidate('b.example')], State, 1)).toEqual([
    { SourceDomain: 'a.example', Target: 'a.example', Protocol: 'HTTP', PriorityKind: 'RetryOriginalHttp' }
  ])
})

test('BuildDomainCandidates keeps global Git ordering across parallel file workers', async () => {
  const WorkingDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-candidates-'))
  const Git = simpleGit({ baseDir: WorkingDirectory })
  await Git.init(['--quiet', '--initial-branch=main'])
  await Git.addConfig('user.email', 'test@example.com')
  await Git.addConfig('user.name', 'Test')

  Fs.writeFileSync(Path.join(WorkingDirectory, 'older.txt'), '||ads.example.net^$domain=older.example.com\n')
  await Git.env({ GIT_AUTHOR_DATE: '@1000 +0000', GIT_COMMITTER_DATE: '@1000 +0000' }).add('--all')
  await Git.env({ GIT_AUTHOR_DATE: '@1000 +0000', GIT_COMMITTER_DATE: '@1000 +0000' }).commit('Add older', ['--quiet'])

  Fs.writeFileSync(Path.join(WorkingDirectory, 'newer.txt'), '||ads.example.net^$domain=newer.example.org\n')
  await Git.env({ GIT_AUTHOR_DATE: '@2000 +0000', GIT_COMMITTER_DATE: '@2000 +0000' }).add('--all')
  await Git.env({ GIT_AUTHOR_DATE: '@2000 +0000', GIT_COMMITTER_DATE: '@2000 +0000' }).commit('Add newer', ['--quiet'])

  const Candidates = await BuildDomainCandidates({
    WorkingDirectory,
    Occurrences: [
      { Domain: 'older.example.com', FilePath: 'older.txt', LineNumber: 1 },
      { Domain: 'newer.example.org', FilePath: 'newer.txt', LineNumber: 1 }
    ],
    State: CreateEmptyState(),
    FallbackAuthorTime: 9000,
    WorkerCount: 2
  })

  expect(Candidates.map(Candidate => Candidate.Domain)).toEqual(['older.example.com', 'newer.example.org'])
})