import { expect, test } from 'vitest'
import { GetDomainModifiedTimesWithWorkers } from '../sources/ordering-pool.ts'
import type { DomainOccurrence } from '../sources/types.ts'

function Occurrence(Domain: string, FilePath: string): DomainOccurrence {
  return { Domain, FilePath, LineNumber: 1 }
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
        ModifiedTimes: Task.Occurrences.map(Occurrence => [Occurrence.Domain, Task.FilePath === 'first.txt' ? 10 : 20])
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