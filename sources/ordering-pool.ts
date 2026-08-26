import * as Process from 'node:process'
import { Piscina } from 'piscina'
import { NormalizeWorkerCount } from './probe-pool.ts'
import type { DomainOccurrence } from './types.ts'
import type { OrderingWorkerResult, OrderingWorkerTask } from './ordering-worker.ts'

export type OrderingPoolOptions = {
  WorkingDirectory: string
  OccurrencesByFile: Map<string, DomainOccurrence[]>
  FallbackAuthorTime: number
  WorkerCount: number
  RunWorker?: OrderingWorkerRunner
}

export type OrderingWorkerRunner = (Task: OrderingWorkerTask) => Promise<OrderingWorkerResult>

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

export async function GetDomainModifiedTimesWithWorkers(Options: OrderingPoolOptions): Promise<Map<string, Map<string, number>>> {
  const Tasks = [...Options.OccurrencesByFile].map(([FilePath, Occurrences]) => ({
    WorkingDirectory: Options.WorkingDirectory,
    FilePath,
    Occurrences,
    FallbackAuthorTime: Options.FallbackAuthorTime
  }))
  if (Tasks.length === 0) {
    return new Map()
  }

  const WorkerCount = Math.min(NormalizeWorkerCount(Options.WorkerCount), Tasks.length)
  const Pool = Options.RunWorker ? null : CreateOrderingPool(WorkerCount)
  const RunWorker = Options.RunWorker ?? RunOrderingWorker(Pool!)

  try {
    const Results = await Promise.all(Tasks.map(Task => RunWorker(Task)))
    return new Map(Results.map(Result => [Result.FilePath, new Map(Result.ModifiedTimes)]))
  } finally {
    await Pool?.destroy()
  }
}