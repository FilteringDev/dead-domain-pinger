import { expect, test } from 'vitest'
import * as Os from 'node:os'
import { GetDefaultOrderingWorkerCount, GetDomainModifiedTimesWithWorkers } from '../sources/ordering-pool.ts'
import { CreateEmptyState } from '../sources/state.ts'
import type { DomainOccurrence } from '../sources/types.ts'

function Occurrence(Domain: string, FilePath: string, LineNumber = 1): DomainOccurrence {
  return { Domain, FilePath, LineNumber, Origin: 'domainList' }
}

test('GetDefaultOrderingWorkerCount uses the available CPU count', () => {
  expect(GetDefaultOrderingWorkerCount()).toBe(Math.max(1, Os.availableParallelism()))
})

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

test('GetDomainModifiedTimesWithWorkers parallelizes lines from one file up to the configured limit', async () => {
  const Occurrences: ReturnType<typeof Occurrence>[] = []
  for (let Index = 0; Index < 5; Index += 1) {
    Occurrences.push(Occurrence(`${Index}.example`, 'list.txt', Index + 1))
  }
  let Active = 0
  let MaximumActive = 0

  await GetDomainModifiedTimesWithWorkers({
    WorkingDirectory: '/filters',
    OccurrencesByFile: new Map([['list.txt', Occurrences]]),
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

test('GetDomainModifiedTimesWithWorkers keeps domains from the same line in one task', async () => {
  const TaskSizes: number[] = []

  await GetDomainModifiedTimesWithWorkers({
    WorkingDirectory: '/filters',
    OccurrencesByFile: new Map([['list.txt', [
      Occurrence('first.example', 'list.txt', 1),
      Occurrence('second.example', 'list.txt', 1),
      Occurrence('third.example', 'list.txt', 2)
    ]]]),
    FallbackAuthorTime: 100,
    WorkerCount: 2,
    RunWorker: Task => {
      TaskSizes.push(Task.Occurrences.length)
      return Promise.resolve({
        FilePath: Task.FilePath,
        ModifiedTimes: Task.Occurrences.map(DomainOccurrence => [DomainOccurrence.Domain, 10]),
        Failures: []
      })
    }
  })

  expect(TaskSizes.sort((Left, Right) => Left - Right)).toEqual([1, 2])
})

test('GetDomainModifiedTimesWithWorkers passes valid state cache entries to workers and retains refreshed entries', async () => {
  const State = CreateEmptyState()
  State.GitOrderCache = [{
    FilePath: 'list.txt',
    Revision: 'a'.repeat(40),
    LineNumber: 1,
    Domain: 'first.example',
    ModifiedAt: 10
  }]

  await GetDomainModifiedTimesWithWorkers({
    WorkingDirectory: '/filters',
    OccurrencesByFile: new Map([['list.txt', [Occurrence('first.example', 'list.txt')]]]),
    FallbackAuthorTime: 100,
    WorkerCount: 1,
    State,
    ResolveFileRevision: () => Promise.resolve('a'.repeat(40)),
    RunWorker: Task => {
      expect(Task.CachedEntries).toEqual([{ LineNumber: 1, Domain: 'first.example', ModifiedAt: 10 }])
      return Promise.resolve({
        FilePath: Task.FilePath,
        ModifiedTimes: [['first.example', 10]],
        Failures: [],
        CacheRevision: Task.CacheRevision,
        CacheEntries: Task.CachedEntries
      })
    }
  })

  expect(State.GitOrderCache).toEqual([{
    FilePath: 'list.txt',
    Revision: 'a'.repeat(40),
    LineNumber: 1,
    Domain: 'first.example',
    ModifiedAt: 10
  }])
})

test('GetDomainModifiedTimesWithWorkers replaces stale entries when a filter revision changes', async () => {
  const State = CreateEmptyState()
  State.GitOrderCache = [{
    FilePath: 'list.txt',
    Revision: 'a'.repeat(40),
    LineNumber: 1,
    Domain: 'first.example',
    ModifiedAt: 10
  }]

  await GetDomainModifiedTimesWithWorkers({
    WorkingDirectory: '/filters',
    OccurrencesByFile: new Map([['list.txt', [Occurrence('first.example', 'list.txt')]]]),
    FallbackAuthorTime: 100,
    WorkerCount: 1,
    State,
    ResolveFileRevision: () => Promise.resolve('b'.repeat(40)),
    RunWorker: Task => {
      expect(Task.CachedEntries).toEqual([])
      return Promise.resolve({
        FilePath: Task.FilePath,
        ModifiedTimes: [['first.example', 20]],
        Failures: [],
        CacheRevision: Task.CacheRevision,
        CacheEntries: [{ LineNumber: 1, Domain: 'first.example', ModifiedAt: 20 }]
      })
    }
  })

  expect(State.GitOrderCache).toEqual([{
    FilePath: 'list.txt',
    Revision: 'b'.repeat(40),
    LineNumber: 1,
    Domain: 'first.example',
    ModifiedAt: 20
  }])
})

test('GetDomainModifiedTimesWithWorkers merges partial file results using the newest domain time', async () => {
  const Result = await GetDomainModifiedTimesWithWorkers({
    WorkingDirectory: '/filters',
    OccurrencesByFile: new Map([['list.txt', [
      Occurrence('shared.example', 'list.txt', 1),
      Occurrence('shared.example', 'list.txt', 2)
    ]]]),
    FallbackAuthorTime: 100,
    WorkerCount: 2,
    RunWorker: async Task => {
      const LineNumber = Task.Occurrences[0].LineNumber
      if (LineNumber === 1) {
        await new Promise(Resolve => setTimeout(Resolve, 10))
      }
      return {
        FilePath: Task.FilePath,
        ModifiedTimes: [['shared.example', LineNumber === 1 ? 20 : 10]],
        Failures: []
      }
    }
  })

  expect(Result.get('list.txt')?.get('shared.example')).toBe(20)
})

test('GetDomainModifiedTimesWithWorkers emits one warning for a degraded file', async () => {
  const Warnings: string[] = []

  await GetDomainModifiedTimesWithWorkers({
    WorkingDirectory: '/filters',
    OccurrencesByFile: new Map([['list.txt', [
      Occurrence('first.example', 'list.txt', 1),
      Occurrence('second.example', 'list.txt', 2)
    ]]]),
    FallbackAuthorTime: 100,
    WorkerCount: 2,
    OnWarning: Warning => Warnings.push(Warning),
    RunWorker: Task => Promise.resolve({
      FilePath: Task.FilePath,
      ModifiedTimes: Task.Occurrences.map(DomainOccurrence => [DomainOccurrence.Domain, 100]),
      Failures: [
        { Operation: 'blame', Message: 'exit code 1' },
        { Operation: 'file history', Message: 'exit code 1' }
      ]
    })
  })

  expect(Warnings).toHaveLength(1)
  expect(Warnings[0]).toContain('blame: exit code 1; file history: exit code 1')
})
