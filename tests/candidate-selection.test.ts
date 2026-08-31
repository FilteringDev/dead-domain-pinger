import { expect, test } from 'vitest'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { BuildDomainCandidates, SelectProbeWork } from '../sources/candidate-selection.ts'
import { CreateEmptyState, QueuePendingProbe } from '../sources/state.ts'
import type { DomainCandidate } from '../sources/types.ts'
import { RunGit } from './git.ts'

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

test('pending HTTP work takes priority and replaces the normal HTTPS work for its source domain', () => {
  const State = CreateEmptyState()
  QueuePendingProbe(State, 'b.example', 'www.b.example', 'TryWwwHttp')

  expect(SelectProbeWork([Candidate('a.example'), Candidate('b.example')], State, 3)).toEqual([
    { SourceDomain: 'b.example', Target: 'www.b.example', Protocol: 'HTTP', PriorityKind: 'TryWwwHttp', Origins: ['domainList'] },
    { SourceDomain: 'a.example', Target: 'a.example', Protocol: 'HTTPS', PriorityKind: null, Origins: ['domainList'] }
  ])
})

test('priority work consumes the same candidate limit as normal work', () => {
  const State = CreateEmptyState()
  QueuePendingProbe(State, 'a.example', 'a.example', 'RetryOriginalHttp')

  expect(SelectProbeWork([Candidate('a.example'), Candidate('b.example')], State, 1)).toEqual([
    { SourceDomain: 'a.example', Target: 'a.example', Protocol: 'HTTP', PriorityKind: 'RetryOriginalHttp', Origins: ['domainList'] }
  ])
})

test('BuildDomainCandidates keeps global Git ordering across parallel file workers', async () => {
  const WorkingDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-candidates-'))
  await RunGit(WorkingDirectory, ['init', '--quiet', '--initial-branch=main'])
  await RunGit(WorkingDirectory, ['config', 'user.email', 'test@example.com'])
  await RunGit(WorkingDirectory, ['config', 'user.name', 'Test'])

  Fs.writeFileSync(Path.join(WorkingDirectory, 'older.txt'), '||ads.example.net^$domain=older.example.com\n')
  const OlderEnvironment = { GIT_AUTHOR_DATE: '@1000 +0000', GIT_COMMITTER_DATE: '@1000 +0000' }
  await RunGit(WorkingDirectory, ['add', '--all'], OlderEnvironment)
  await RunGit(WorkingDirectory, ['commit', '--quiet', '-m', 'Add older'], OlderEnvironment)

  Fs.writeFileSync(Path.join(WorkingDirectory, 'newer.txt'), '||ads.example.net^$domain=newer.example.org\n')
  const NewerEnvironment = { GIT_AUTHOR_DATE: '@2000 +0000', GIT_COMMITTER_DATE: '@2000 +0000' }
  await RunGit(WorkingDirectory, ['add', '--all'], NewerEnvironment)
  await RunGit(WorkingDirectory, ['commit', '--quiet', '-m', 'Add newer'], NewerEnvironment)

  const Candidates = await BuildDomainCandidates({
    WorkingDirectory,
    Occurrences: [
      { Domain: 'older.example.com', FilePath: 'older.txt', LineNumber: 1, Origin: 'domainList' },
      { Domain: 'newer.example.org', FilePath: 'newer.txt', LineNumber: 1, Origin: 'domainList' }
    ],
    State: CreateEmptyState(),
    FallbackAuthorTime: 9000,
    OrderingWorkerCount: 2
  })

  expect(Candidates.map(Candidate => Candidate.Domain)).toEqual(['older.example.com', 'newer.example.org'])

})
test('BuildDomainCandidates accumulates every origin for a shared domain', async () => {
  const Candidates = await BuildDomainCandidates({
    WorkingDirectory: '/',
    Occurrences: [
      { Domain: 'example.com', FilePath: 'list.txt', LineNumber: 1, Origin: 'domainList' },
      { Domain: 'example.com', FilePath: 'list.txt', LineNumber: 2, Origin: 'networkPattern' }
    ],
    State: CreateEmptyState(),
    FallbackAuthorTime: 1000,
    OrderingWorkerCount: 1
  })

  expect(Candidates).toHaveLength(1)
  expect(Candidates[0].Origins).toEqual(['networkPattern', 'domainList'])
  expect(Candidates[0].Occurrences).toHaveLength(2)
})
