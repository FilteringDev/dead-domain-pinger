import test from 'node:test'
import assert from 'node:assert/strict'
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { GetDomainModifiedTimes } from '../sources/domain-history.ts'
import type { DomainOccurrence } from '../sources/types.ts'

const FileName = 'filters.txt'

function CreateRepository(): string {
  const Directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-history-'))

  ChildProcess.execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: Directory })
  ChildProcess.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: Directory })
  ChildProcess.execFileSync('git', ['config', 'user.name', 'Test'], { cwd: Directory })

  return Directory
}

function Commit(Directory: string, Content: string, AuthorTime: number): void {
  Fs.writeFileSync(Path.join(Directory, FileName), Content)

  const Date = `@${AuthorTime} +0000`
  ChildProcess.execFileSync('git', ['add', '--all'], { cwd: Directory })
  ChildProcess.execFileSync('git', ['commit', '--quiet', '--message', `Update at ${AuthorTime}`], {
    cwd: Directory,
    env: { ...process.env, GIT_AUTHOR_DATE: Date, GIT_COMMITTER_DATE: Date }
  })
}

function Occurrence(Domain: string, LineNumber: number): DomainOccurrence {
  return { Domain, FilePath: FileName, LineNumber }
}

test('A domain added to an existing rule does not refresh its neighbours', () => {
  const Directory = CreateRepository()
  Commit(Directory, '||ads.example^$domain=first.example\n', 1000)
  Commit(Directory, '||ads.example^$domain=first.example|second.example\n', 2000)

  const ModifiedTimes = GetDomainModifiedTimes(Directory, FileName, [
    Occurrence('first.example', 1),
    Occurrence('second.example', 1)
  ], 9000)

  assert.equal(ModifiedTimes.get('first.example'), 1000)
  assert.equal(ModifiedTimes.get('second.example'), 2000)
})

test('Rewriting a rule keeps the date of the domains it already had', () => {
  const Directory = CreateRepository()
  Commit(Directory, 'first.example##.ad\n', 1000)
  Commit(Directory, 'first.example##.ad-banner\n', 2000)

  const ModifiedTimes = GetDomainModifiedTimes(Directory, FileName, [Occurrence('first.example', 1)], 9000)

  assert.equal(ModifiedTimes.get('first.example'), 1000)
})

test('Moving a domain to another line keeps its original date', () => {
  const Directory = CreateRepository()
  Commit(Directory, '||ads.example^$domain=first.example|second.example\n', 1000)
  Commit(Directory, '||ads.example^$domain=first.example\n||track.example^$domain=second.example\n', 2000)

  const ModifiedTimes = GetDomainModifiedTimes(Directory, FileName, [
    Occurrence('first.example', 1),
    Occurrence('second.example', 2)
  ], 9000)

  assert.equal(ModifiedTimes.get('first.example'), 1000)
  assert.equal(ModifiedTimes.get('second.example'), 1000)
})

test('A domain re-added after a removal uses the newest date', () => {
  const Directory = CreateRepository()
  Commit(Directory, '||ads.example^$domain=first.example\n', 1000)
  Commit(Directory, '||ads.example^$domain=other.example\n', 2000)
  Commit(Directory, '||ads.example^$domain=other.example\n||track.example^$domain=first.example\n', 3000)

  const ModifiedTimes = GetDomainModifiedTimes(Directory, FileName, [
    Occurrence('other.example', 1),
    Occurrence('first.example', 2)
  ], 9000)

  assert.equal(ModifiedTimes.get('first.example'), 3000)
})

test('Uncommitted files fall back to the given time', () => {
  const Directory = CreateRepository()
  Commit(Directory, '||ads.example^$domain=first.example\n', 1000)
  Fs.writeFileSync(Path.join(Directory, 'extra.txt'), '||ads.example^$domain=fresh.example\n')

  const ModifiedTimes = GetDomainModifiedTimes(Directory, 'extra.txt', [
    { Domain: 'fresh.example', FilePath: 'extra.txt', LineNumber: 1 }
  ], 9000)

  assert.equal(ModifiedTimes.get('fresh.example'), 9000)
})
