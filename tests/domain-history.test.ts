import { expect, test } from 'vitest'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { ConsumeSeparatedRecords, GetDomainModifiedTimes } from '../sources/domain-history.ts'
import type { GitHistoryFailure } from '../sources/domain-history.ts'
import type { DomainOccurrence } from '../sources/types.ts'
import { RunGit } from './git.ts'

const FileName = 'filters.txt'

async function CreateRepository(): Promise<string> {
  const Directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-history-'))
  await RunGit(Directory, ['init', '--quiet', '--initial-branch=main'])
  await RunGit(Directory, ['config', 'user.email', 'test@example.com'])
  await RunGit(Directory, ['config', 'user.name', 'Test'])

  return Directory
}

async function Commit(Directory: string, Content: string, AuthorTime: number): Promise<void> {
  Fs.writeFileSync(Path.join(Directory, FileName), Content)

  const Date = `@${AuthorTime} +0000`
  const Environment = {
    GIT_AUTHOR_DATE: Date,
    GIT_COMMITTER_DATE: Date
  }
  await RunGit(Directory, ['add', '--all'], Environment)
  await RunGit(Directory, ['commit', '--quiet', '-m', `Update at ${AuthorTime}`], Environment)
}

function Occurrence(Domain: string, LineNumber: number): DomainOccurrence {
  return { Domain, FilePath: FileName, LineNumber, Origin: 'domainList' }
}

test('A domain added to an existing rule does not refresh its neighbours', async () => {
  const Directory = await CreateRepository()
  await Commit(Directory, '||ads.example.net^$domain=first.example.com\n', 1000)
  await Commit(Directory, '||ads.example.net^$domain=first.example.com|second.example.org\n', 2000)

  const ModifiedTimes = await GetDomainModifiedTimes(Directory, FileName, [
    Occurrence('first.example.com', 1),
    Occurrence('second.example.org', 1)
  ], 9000)

  expect(ModifiedTimes.get('first.example.com')).toBe(1000)
  expect(ModifiedTimes.get('second.example.org')).toBe(2000)
})

test('Rewriting a rule keeps the date of the domains it already had', async () => {
  const Directory = await CreateRepository()
  await Commit(Directory, 'first.example.com##.ad\n', 1000)
  await Commit(Directory, 'first.example.com##.ad-banner\n', 2000)

  const ModifiedTimes = await GetDomainModifiedTimes(Directory, FileName, [Occurrence('first.example.com', 1)], 9000)

  expect(ModifiedTimes.get('first.example.com')).toBe(1000)
})

test('Changing a network rule path keeps the pattern hostname date', async () => {
  const Directory = await CreateRepository()
  await Commit(Directory, '||cdn.example.com/old-path\n', 1000)
  await Commit(Directory, '||cdn.example.com/new-path\n', 2000)

  const ModifiedTimes = await GetDomainModifiedTimes(Directory, FileName, [Occurrence('cdn.example.com', 1)], 9000)

  expect(ModifiedTimes.get('cdn.example.com')).toBe(1000)
})

test('Moving a domain to another line keeps its original date', async () => {
  const Directory = await CreateRepository()
  await Commit(Directory, '||ads.example.net^$domain=first.example.com|second.example.org\n', 1000)
  await Commit(Directory, '||ads.example.net^$domain=first.example.com\n||track.example.net^$domain=second.example.org\n', 2000)

  const ModifiedTimes = await GetDomainModifiedTimes(Directory, FileName, [
    Occurrence('first.example.com', 1),
    Occurrence('second.example.org', 2)
  ], 9000)

  expect(ModifiedTimes.get('first.example.com')).toBe(1000)
  expect(ModifiedTimes.get('second.example.org')).toBe(1000)
})

test('A domain re-added after a removal uses the newest date', async () => {
  const Directory = await CreateRepository()
  await Commit(Directory, '||ads.example.net^$domain=first.example.com\n', 1000)
  await Commit(Directory, '||ads.example.net^$domain=other.example.net\n', 2000)
  await Commit(Directory, '||ads.example.net^$domain=other.example.net\n||track.example.net^$domain=first.example.com\n', 3000)

  const ModifiedTimes = await GetDomainModifiedTimes(Directory, FileName, [
    Occurrence('other.example.net', 1),
    Occurrence('first.example.com', 2)
  ], 9000)

  expect(ModifiedTimes.get('first.example.com')).toBe(3000)
})

test('Uncommitted files fall back to the given time', async () => {
  const Directory = await CreateRepository()
  await Commit(Directory, '||ads.example.net^$domain=first.example.com\n', 1000)
  Fs.writeFileSync(Path.join(Directory, 'extra.txt'), '||ads.example.net^$domain=fresh.example.dev\n')

  const ModifiedTimes = await GetDomainModifiedTimes(Directory, 'extra.txt', [
    { Domain: 'fresh.example.dev', FilePath: 'extra.txt', LineNumber: 1, Origin: 'domainList' }
  ], 9000)

  expect(ModifiedTimes.get('fresh.example.dev')).toBe(9000)
})

test('ConsumeSeparatedRecords yields records before the remaining history is available', async () => {
  let ReleaseRemaining: (() => void) | undefined
  const Remaining = new Promise<void>(Resolve => {
    ReleaseRemaining = Resolve
  })
  let SawFirst: (() => void) | undefined
  const First = new Promise<void>(Resolve => {
    SawFirst = Resolve
  })

  async function* Chunks(): AsyncGenerator<string> {
    yield '\u0000first\u0000'
    await Remaining
    yield 'sec'
    yield 'ond'
  }

  const Records: string[] = []
  const Consumption = ConsumeSeparatedRecords(Chunks(), '\u0000', Record => {
    Records.push(Record)
    SawFirst?.()
    return true
  })

  await First
  expect(Records).toEqual(['first'])
  ReleaseRemaining?.()
  await expect(Consumption).resolves.toEqual({ Completed: true, Pending: 'second' })
})

test('Git failures fall back to the given time and are deduplicated by operation', async () => {
  const Failures: GitHistoryFailure[] = []
  const ModifiedTimes = await GetDomainModifiedTimes('/path/that/does/not/exist', FileName, [
    Occurrence('first.example.com', 1),
    Occurrence('second.example.org', 2)
  ], 9000, Failures)

  expect(ModifiedTimes).toEqual(new Map([
    ['first.example.com', 9000],
    ['second.example.org', 9000]
  ]))
  expect(Failures.map(Failure => Failure.Operation)).toEqual(['blame'])
})
