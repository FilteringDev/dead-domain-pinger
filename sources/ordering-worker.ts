import { GetDomainModifiedTimes } from './domain-history.ts'
import type { GitHistoryFailure, GitOrderCacheEntry } from './domain-history.ts'
import type { DomainOccurrence } from './types.ts'

export type OrderingWorkerTask = {
  WorkingDirectory: string
  FilePath: string
  Occurrences: DomainOccurrence[]
  FallbackAuthorTime: number
  CacheRevision?: string
  CachedEntries?: GitOrderCacheEntry[]
}

export type OrderingWorkerResult = {
  FilePath: string
  ModifiedTimes: Array<[string, number]>
  Failures: GitHistoryFailure[]
  CacheRevision?: string
  CacheEntries?: GitOrderCacheEntry[]
}

export default async function OrderingWorkerHandler(Task: OrderingWorkerTask): Promise<OrderingWorkerResult> {
  const Failures: GitHistoryFailure[] = []
  const ModifiedTimes = await GetDomainModifiedTimes(
    Task.WorkingDirectory,
    Task.FilePath,
    Task.Occurrences,
    Task.FallbackAuthorTime,
    Failures,
    Task.CachedEntries
  )

  const CacheEntries = Task.CacheRevision && Failures.length === 0
    ? Task.Occurrences.flatMap(Occurrence => {
      const ModifiedAt = ModifiedTimes.get(Occurrence.Domain)
      return ModifiedAt === undefined ? [] : [{
        LineNumber: Occurrence.LineNumber,
        Domain: Occurrence.Domain,
        ModifiedAt
      }]
    })
    : undefined

  return {
    FilePath: Task.FilePath,
    ModifiedTimes: [...ModifiedTimes.entries()],
    Failures,
    ...(Task.CacheRevision ? { CacheRevision: Task.CacheRevision } : {}),
    ...(CacheEntries ? { CacheEntries } : {})
  }
}
