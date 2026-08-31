import { expect, test } from 'vitest'
import { GetDomainModifiedTimesWithWorkers } from '../sources/ordering-pool.ts'
import type { DomainOccurrence } from '../sources/types.ts'

function Occurrence(Domain: string, FilePath: string): DomainOccurrence {
  return { Domain, FilePath, LineNumber: 1, Origin: 'domainList' }
}

test('GetDomainModifiedTimesWithWorkers associates results with their file after out-of-order completion', async () => {
  const OccurrencesByFile = new Map([
    ['first.txt', [Occurrence('first.example', 'first.txt')]],
    ['second.txt', [Occurrence('second.example', 'second.txt')]]
  ])

  const Result = await GetDomainModifiedTimesWithWorkers({
    WorkingDirectory: '/filters',
    OccurrencesByFile,
    FallbackAuthorTime: 100,
    WorkerCount: 2,
    RunWorker: async Task => {
      if (Task.FilePath === 'first.txt') {
        await new Promise(Resolve => setTimeout(Resolve, 10))
      }

      return {
        FilePath: Task.FilePath,
        ModifiedTimes: Task.Occurrences.map(Occurrence => [Occurrence.Domain, Task.FilePath === 'first.txt' ? 10 : 20]),
        Failures: []
      }
    }
  })

  expect(Result).toEqual(new Map([
    ['first.txt', new Map([['first.example', 10]])],
    ['second.txt', new Map([['second.example', 20]])]
  ]))
})

test('GetDomainModifiedTimesWithWorkers skips worker creation when no files need ordering', async () => {
  const Result = await GetDomainModifiedTimesWithWorkers({
    WorkingDirectory: '/filters',
    OccurrencesByFile: new Map(),
    FallbackAuthorTime: 100,
    WorkerCount: 1,
    RunWorker: () => Promise.reject(new Error('worker should not run'))
  })

  expect(Result).toEqual(new Map())
})

test('GetDomainModifiedTimesWithWorkers lazily runs only the configured number of file tasks', async () => {
  const OccurrencesByFile = new Map<string, ReturnType<typeof Occurrence>[]>()
  for (let Index = 0; Index < 5; Index += 1) {
    const FilePath = `${Index}.txt`
    OccurrencesByFile.set(FilePath, [Occurrence(`${Index}.example`, FilePath)])
  }
  let Active = 0
  let MaximumActive = 0

  await GetDomainModifiedTimesWithWorkers({
    WorkingDirectory: '/filters',
    OccurrencesByFile,
    FallbackAuthorTime: 100,
    WorkerCount: 2,
    RunWorker: async Task => {
      Active += 1
      MaximumActive = Math.max(MaximumActive, Active)
      await new Promise(Resolve => setTimeout(Resolve, 5))
      Active -= 1
      return {
        FilePath: Task.FilePath,
        ModifiedTimes: Task.Occurrences.map(DomainOccurrence => [DomainOccurrence.Domain, 10]),
        Failures: []
      }
    }
  })

  expect(MaximumActive).toBe(2)
})

test('GetDomainModifiedTimesWithWorkers emits one warning for a degraded file', async () => {
  const Warnings: string[] = []

  await GetDomainModifiedTimesWithWorkers({
    WorkingDirectory: '/filters',
    OccurrencesByFile: new Map([['list.txt', [Occurrence('first.example', 'list.txt')]]]),
    FallbackAuthorTime: 100,
    WorkerCount: 1,
    OnWarning: Warning => Warnings.push(Warning),
    RunWorker: Task => Promise.resolve({
      FilePath: Task.FilePath,
      ModifiedTimes: [['first.example', 100]],
      Failures: [
        { Operation: 'blame', Message: 'exit code 1' },
        { Operation: 'file history', Message: 'exit code 1' }
      ]
    })
  })

  expect(Warnings).toHaveLength(1)
  expect(Warnings[0]).toContain('blame: exit code 1; file history: exit code 1')
})
