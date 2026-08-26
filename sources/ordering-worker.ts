import { GetDomainModifiedTimes } from './domain-history.ts'
import type { DomainOccurrence } from './types.ts'

export type OrderingWorkerTask = {
  WorkingDirectory: string
  FilePath: string
  Occurrences: DomainOccurrence[]
  FallbackAuthorTime: number
}

export type OrderingWorkerResult = {
  FilePath: string
  ModifiedTimes: Array<[string, number]>
}

export default async function OrderingWorkerHandler(Task: OrderingWorkerTask): Promise<OrderingWorkerResult> {
  const ModifiedTimes = await GetDomainModifiedTimes(
    Task.WorkingDirectory,
    Task.FilePath,
    Task.Occurrences,
    Task.FallbackAuthorTime
  )

  return { FilePath: Task.FilePath, ModifiedTimes: [...ModifiedTimes.entries()] }
}