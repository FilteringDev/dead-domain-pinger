import test from 'node:test'
import assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { simpleGit } from 'simple-git'
import { GetDomainModifiedTimes } from '../sources/domain-history.ts'
import type { DomainOccurrence } from '../sources/types.ts'

const FileName = 'filters.txt'

async function CreateRepository(): Promise<string> {
  const Directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-history-'))
  const Git = simpleGit({ baseDir: Directory })

  await Git.init(['--quiet', '--initial-branch=main'])
  await Git.addConfig('user.email', 'test@example.com')
  await Git.addConfig('user.name', 'Test')

  return Directory
}

async function Commit(Directory: string, Content: string, AuthorTime: number): Promise<void> {
  Fs.writeFileSync(Path.join(Directory, FileName), Content)

  const Date = `@${AuthorTime} +0000`
  const Git = simpleGit({ baseDir: Directory }).env({
    GIT_AUTHOR_DATE: Date,
    GIT_COMMITTER_DATE: Date
  })
  await Git.add('--all')
  await Git.commit(`Update at ${AuthorTime}`, ['--quiet'])
}

function Occurrence(Domain: string, LineNumber: number): DomainOccurrence {
  return { Domain, FilePath: FileName, LineNumber }
}

test('A domain added to an existing rule does not refresh its neighbours', async () => {
  const Directory = await CreateRepository()
  await Commit(Directory, '||ads.example^$domain=first.example\n', 1000)
  await Commit(Directory, '||ads.example^$domain=first.example|second.example\n', 2000)

  const ModifiedTimes = await GetDomainModifiedTimes(Directory, FileName, [
    Occurrence('first.example', 1),
    Occurrence('second.example', 1)
  ], 9000)

  assert.equal(ModifiedTimes.get('first.example'), 1000)
  assert.equal(ModifiedTimes.get('second.example'), 2000)
})

test('Rewriting a rule keeps the date of the domains it already had', async () => {
  const Directory = await CreateRepository()
  await Commit(Directory, 'first.example##.ad\n', 1000)
  await Commit(Directory, 'first.example##.ad-banner\n', 2000)

  const ModifiedTimes = await GetDomainModifiedTimes(Directory, FileName, [Occurrence('first.example', 1)], 9000)

  assert.equal(ModifiedTimes.get('first.example'), 1000)
})

test('Moving a domain to another line keeps its original date', async () => {
  const Directory = await CreateRepository()
  await Commit(Directory, '||ads.example^$domain=first.example|second.example\n', 1000)
  await Commit(Directory, '||ads.example^$domain=first.example\n||track.example^$domain=second.example\n', 2000)

  const ModifiedTimes = await GetDomainModifiedTimes(Directory, FileName, [
    Occurrence('first.example', 1),
    Occurrence('second.example', 2)
  ], 9000)

  assert.equal(ModifiedTimes.get('first.example'), 1000)
  assert.equal(ModifiedTimes.get('second.example'), 1000)
})

test('A domain re-added after a removal uses the newest date', async () => {
  const Directory = await CreateRepository()
  await Commit(Directory, '||ads.example^$domain=first.example\n', 1000)
  await Commit(Directory, '||ads.example^$domain=other.example\n', 2000)
  await Commit(Directory, '||ads.example^$domain=other.example\n||track.example^$domain=first.example\n', 3000)

  const ModifiedTimes = await GetDomainModifiedTimes(Directory, FileName, [
    Occurrence('other.example', 1),
    Occurrence('first.example', 2)
  ], 9000)

  assert.equal(ModifiedTimes.get('first.example'), 3000)
})

test('Uncommitted files fall back to the given time', async () => {
  const Directory = await CreateRepository()
  await Commit(Directory, '||ads.example^$domain=first.example\n', 1000)
  Fs.writeFileSync(Path.join(Directory, 'extra.txt'), '||ads.example^$domain=fresh.example\n')

  const ModifiedTimes = await GetDomainModifiedTimes(Directory, 'extra.txt', [
    { Domain: 'fresh.example', FilePath: 'extra.txt', LineNumber: 1 }
  ], 9000)

  assert.equal(ModifiedTimes.get('fresh.example'), 9000)
})
