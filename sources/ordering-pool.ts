import * as Os from 'node:os'
import * as Process from 'node:process'
import { Piscina } from 'piscina'
import { GetFileHistoryRevision } from './domain-history.ts'
import type { GitHistoryFailure, GitOrderCacheEntry } from './domain-history.ts'
import type { DeadDomainState } from './state.ts'
import type { DomainOccurrence } from './types.ts'
import type { OrderingWorkerResult, OrderingWorkerTask } from './ordering-worker.ts'

export type OrderingPoolOptions = {
  WorkingDirectory: string
  OccurrencesByFile: Map<string, DomainOccurrence[]>
  FallbackAuthorTime: number
  WorkerCount: number
  State?: DeadDomainState
  ResolveFileRevision?: (WorkingDirectory: string, FilePath: string) => Promise<string | null>
  RunWorker?: OrderingWorkerRunner
  OnWarning?: (Message: string) => void
}

export type OrderingWorkerRunner = (Task: OrderingWorkerTask) => Promise<OrderingWorkerResult>

export function GetDefaultOrderingWorkerCount(): number {
  return Math.max(1, Os.availableParallelism())
}

function NormalizeOrderingWorkerCount(WorkerCount: number): number {
  return Number.isInteger(WorkerCount) && WorkerCount > 0 ? WorkerCount : GetDefaultOrderingWorkerCount()
}

function GetWorkerExecArgv(): string[] {
  const Arguments: string[] = []

  for (let Index = 0; Index < Process.execArgv.length; Index += 1) {
    const Argument = Process.execArgv[Index]
    if (Argument === '--import') {
      const Module = Process.execArgv[Index + 1]
      if (Module) {
        Arguments.push(Argument, Module)
        Index += 1
      }
    } else if (Argument.startsWith('--import=')) {
      Arguments.push(Argument)
    }
  }

  return Arguments
}

function CreateOrderingPool(WorkerCount: number): Piscina {
  return new Piscina({
    filename: new URL('./ordering-worker.ts', import.meta.url).href,
    minThreads: WorkerCount,
    maxThreads: WorkerCount,
    execArgv: GetWorkerExecArgv()
  })
}

function RunOrderingWorker(Pool: Piscina): OrderingWorkerRunner {
  return Task => Pool.run(Task)
}

type FileCache = {
  Revision: string
  Entries: GitOrderCacheEntry[]
}

function CreateOrderingTasks(Options: OrderingPoolOptions, CacheByFile: Map<string, FileCache>): OrderingWorkerTask[] {
  const Tasks: OrderingWorkerTask[] = []

  for (const [FilePath, Occurrences] of Options.OccurrencesByFile) {
    const OccurrencesByLine = Map.groupBy(Occurrences, Occurrence => Occurrence.LineNumber)
    for (const LineOccurrences of OccurrencesByLine.values()) {
      const Cache = CacheByFile.get(FilePath)
      Tasks.push({
        WorkingDirectory: Options.WorkingDirectory,
        FilePath,
        Occurrences: LineOccurrences,
        FallbackAuthorTime: Options.FallbackAuthorTime,
        ...(Cache ? {
          CacheRevision: Cache.Revision,
          CachedEntries: Cache.Entries.filter(Entry => LineOccurrences.some(Occurrence => (
            Occurrence.LineNumber === Entry.LineNumber && Occurrence.Domain === Entry.Domain
          )))
        } : {})
      })
    }
  }

  return Tasks
}

async function GetCacheByFile(Options: OrderingPoolOptions): Promise<Map<string, FileCache>> {
  if (!Options.State) {
    return new Map()
  }

  const ResolveFileRevision = Options.ResolveFileRevision ?? GetFileHistoryRevision
  const Revisions = await Promise.all([...Options.OccurrencesByFile.keys()].map(async FilePath => ({
    FilePath,
    Revision: await ResolveFileRevision(Options.WorkingDirectory, FilePath)
  })))
  const CacheByFile = new Map<string, FileCache>()

  for (const { FilePath, Revision } of Revisions) {
    if (!Revision) {
      continue
    }

    CacheByFile.set(FilePath, {
      Revision,
      Entries: Options.State.GitOrderCache
        .filter(Entry => Entry.FilePath === FilePath && Entry.Revision === Revision)
        .map(Entry => ({ LineNumber: Entry.LineNumber, Domain: Entry.Domain, ModifiedAt: Entry.ModifiedAt }))
    })
  }

  return CacheByFile
}

function MergeCacheEntries(State: DeadDomainState | undefined, CacheByFile: Map<string, FileCache>, Results: OrderingWorkerResult[]): void {
  if (!State || CacheByFile.size === 0) {
    return
  }

  const RefreshableFiles = new Map([...CacheByFile].map(([FilePath, Cache]) => [FilePath, Cache.Revision]))
  const Entries = State.GitOrderCache.filter(Entry => {
    const Revision = RefreshableFiles.get(Entry.FilePath)
    return Revision === undefined || Entry.Revision === Revision
  })
  const Keys = new Set(Entries.map(Entry => `${Entry.FilePath}\u0000${Entry.Revision}\u0000${Entry.LineNumber}\u0000${Entry.Domain}`))

  for (const Result of Results) {
    if (!Result.CacheRevision || !Result.CacheEntries) {
      continue
    }
    for (const Entry of Result.CacheEntries) {
      const Key = `${Result.FilePath}\u0000${Result.CacheRevision}\u0000${Entry.LineNumber}\u0000${Entry.Domain}`
      if (!Keys.has(Key)) {
        Keys.add(Key)
        Entries.push({ FilePath: Result.FilePath, Revision: Result.CacheRevision, ...Entry })
      }
    }
  }

  State.GitOrderCache = Entries
}

function MergeModifiedTimes(
  Results: Map<string, Map<string, number>>,
  Result: OrderingWorkerResult
): void {
  const FileResults = Results.get(Result.FilePath) ?? new Map<string, number>()
  Results.set(Result.FilePath, FileResults)

  for (const [Domain, ModifiedAt] of Result.ModifiedTimes) {
    FileResults.set(Domain, Math.max(FileResults.get(Domain) ?? ModifiedAt, ModifiedAt))
  }
}

function AddFailures(
  FailuresByFile: Map<string, Map<string, GitHistoryFailure>>,
  Result: OrderingWorkerResult
): void {
  if (Result.Failures.length === 0) {
    return
  }

  const FileFailures = FailuresByFile.get(Result.FilePath) ?? new Map<string, GitHistoryFailure>()
  FailuresByFile.set(Result.FilePath, FileFailures)
  for (const Failure of Result.Failures) {
    FileFailures.set(Failure.Operation, Failure)
  }
}

export async function GetDomainModifiedTimesWithWorkers(Options: OrderingPoolOptions): Promise<Map<string, Map<string, number>>> {
  const CacheByFile = await GetCacheByFile(Options)
  const Tasks = CreateOrderingTasks(Options, CacheByFile)
  if (Tasks.length === 0) {
    return new Map()
  }

  const WorkerCount = Math.min(NormalizeOrderingWorkerCount(Options.WorkerCount), Tasks.length)
  const Pool = Options.RunWorker ? null : CreateOrderingPool(WorkerCount)
  const RunWorker = Options.RunWorker ?? RunOrderingWorker(Pool!)
  const Results = new Map<string, Map<string, number>>()
  const FailuresByFile = new Map<string, Map<string, GitHistoryFailure>>()
  const WorkerResults: OrderingWorkerResult[] = []
  let NextIndex = 0

  const RunNext = async (): Promise<void> => {
    for (;;) {
      const TaskIndex = NextIndex
      NextIndex += 1
      if (TaskIndex >= Tasks.length) {
        return
      }

      const Result = await RunWorker(Tasks[TaskIndex])
      MergeModifiedTimes(Results, Result)
      AddFailures(FailuresByFile, Result)
      WorkerResults.push(Result)
    }
  }

  try {
    await Promise.all(Array.from({ length: WorkerCount }, RunNext))
    MergeCacheEntries(Options.State, CacheByFile, WorkerResults)
    for (const [FilePath, Failures] of FailuresByFile) {
      const Details = [...Failures.values()].map(Failure => `${Failure.Operation}: ${Failure.Message}`).join('; ')
      Options.OnWarning?.(`Git history ordering degraded for ${FilePath} (${Details}); fallback timestamps were used`)
    }
    return Results
  } finally {
    await Pool?.destroy()
  }
}
