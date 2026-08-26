import InitSqlJs from 'sql.js'
import { randomUUID } from 'node:crypto'
import * as Fs from 'node:fs'
import { createRequire } from 'node:module'
import * as Path from 'node:path'
import * as Zod from 'zod'
import type { DomainVerdict, PendingProbe, PriorityProbeKind } from './types.ts'

export const StateFileName = 'dead-domain-state.sqlite'

const Require = createRequire(import.meta.url)
const SqlWasmPath = Require.resolve('sql.js/dist/sql-wasm.wasm')

const StateSchema = Zod.object({
  Version: Zod.literal(1),
  Domains: Zod.record(Zod.string(), Zod.object({
    LastCheckedAt: Zod.number(),
    LastVerdict: Zod.enum(['Alive', 'Dead', 'Unknown']),
    LastWarnings: Zod.array(Zod.string()).optional(),
    ModifiedAtOverride: Zod.number().optional()
  })),
  PendingProbes: Zod.record(Zod.string(), Zod.object({
    Target: Zod.string().nonempty(),
    Kind: Zod.enum(['RetryOriginalHttp', 'TryWwwHttp'])
  }))
})

const DomainStateRowSchema = Zod.object({
  domain: Zod.string(),
  last_checked_at: Zod.number(),
  last_verdict: Zod.enum(['Alive', 'Dead', 'Unknown']),
  last_warnings_json: Zod.string().nullable(),
  modified_at_override: Zod.number().nullable()
})

const PendingProbeRowSchema = Zod.object({
  source_domain: Zod.string(),
  target: Zod.string().nonempty(),
  kind: Zod.enum(['RetryOriginalHttp', 'TryWwwHttp'])
})

const WarningsSchema = Zod.array(Zod.string())

export type DeadDomainState = Zod.infer<typeof StateSchema>

let SqlJsPromise: ReturnType<typeof InitSqlJs> | null = null

async function GetSqlJs(): ReturnType<typeof InitSqlJs> {
  SqlJsPromise ??= InitSqlJs({ locateFile: () => SqlWasmPath })

  return SqlJsPromise
}

async function OpenStateDatabase(StateFilePath: string): Promise<InstanceType<(Awaited<ReturnType<typeof InitSqlJs>>)['Database']>> {
  const SqlJs = await GetSqlJs()

  if (!Fs.existsSync(StateFilePath)) {
    return new SqlJs.Database()
  }

  return new SqlJs.Database(Fs.readFileSync(StateFilePath))
}

function EnsureSchema(Database: InstanceType<(Awaited<ReturnType<typeof InitSqlJs>>)['Database']>): void {
  Database.exec('create table if not exists metadata (key text primary key, value text not null)')
  Database.exec('create table if not exists domain_state (domain text primary key, last_checked_at integer not null, last_verdict text not null, last_warnings_json text, modified_at_override integer)')
  Database.exec('create table if not exists pending_probe (source_domain text primary key, target text not null, kind text not null)')

  Database.run('insert or replace into metadata (key, value) values (?, ?)', ['version', '1'])
}

function ParseWarnings(Value: string | null): string[] {
  if (Value === null) {
    return []
  }

  try {
    return WarningsSchema.parse(JSON.parse(Value))
  } catch {
    return []
  }
}

export function CreateEmptyState(): DeadDomainState {
  return { Version: 1, Domains: {}, PendingProbes: {} }
}

/** Reads the SQLite state carried over from the previous run; falls back to an empty state. */
export async function LoadState(StateFilePath: string): Promise<DeadDomainState> {
  try {
    const Database = await OpenStateDatabase(StateFilePath)
    try {
      EnsureSchema(Database)
      const State = CreateEmptyState()

      const Statement = Database.prepare('select domain, last_checked_at, last_verdict, last_warnings_json, modified_at_override from domain_state order by domain')
      try {
        while (Statement.step()) {
          const Row = DomainStateRowSchema.parse(Statement.getAsObject())
          const Warnings = ParseWarnings(Row.last_warnings_json)
          const ModifiedAtOverride = Row.modified_at_override ?? 0

          State.Domains[Row.domain] = {
            LastCheckedAt: Row.last_checked_at,
            LastVerdict: Row.last_verdict,
            ...(Warnings.length > 0 ? { LastWarnings: Warnings } : {}),
            ...(ModifiedAtOverride > 0 ? { ModifiedAtOverride } : {})
          }
        }
      } finally {
        Statement.free()
      }

      const PendingStatement = Database.prepare('select source_domain, target, kind from pending_probe order by source_domain')
      try {
        while (PendingStatement.step()) {
          const Row = PendingProbeRowSchema.parse(PendingStatement.getAsObject())
          State.PendingProbes[Row.source_domain] = { Target: Row.target, Kind: Row.kind }
        }
      } finally {
        PendingStatement.free()
      }

      return StateSchema.parse(State)
    } finally {
      Database.close()
    }
  } catch {
    return CreateEmptyState()
  }
}

export function GetLastCheckedAt(State: DeadDomainState, Domain: string): number {
  return State.Domains[Domain]?.LastCheckedAt ?? 0
}

/** Timestamp that supersedes the git history date of a domain, if one was recorded. */
export function GetModifiedAtOverride(State: DeadDomainState, Domain: string): number {
  return State.Domains[Domain]?.ModifiedAtOverride ?? 0
}

export function GetPendingProbe(State: DeadDomainState, SourceDomain: string): PendingProbe | null {
  return State.PendingProbes[SourceDomain] ?? null
}

export function QueuePendingProbe(State: DeadDomainState, SourceDomain: string, Target: string, Kind: PriorityProbeKind): void {
  State.PendingProbes[SourceDomain] = { Target, Kind }
}

export function ClearPendingProbe(State: DeadDomainState, SourceDomain: string): void {
  delete State.PendingProbes[SourceDomain]
}

export function RecordVerdict(
  State: DeadDomainState,
  Domain: string,
  Verdict: DomainVerdict,
  CheckedAt: number,
  Warnings: string[],
  ModifiedAtOverride?: number
): void {
  // A previously recorded override is carried forward so the domain does not resurface.
  const Override = ModifiedAtOverride ?? GetModifiedAtOverride(State, Domain)

  State.Domains[Domain] = {
    LastCheckedAt: CheckedAt,
    LastVerdict: Verdict,
    ...(Warnings.length > 0 ? { LastWarnings: Warnings } : {}),
    ...(Override > 0 ? { ModifiedAtOverride: Override } : {})
  }
}

/** Drops entries for domains that no longer exist in the filter lists, then persists the SQLite state. */
export async function SaveState(StateFilePath: string, State: DeadDomainState, KnownDomains: Set<string>): Promise<void> {
  const Pruned = CreateEmptyState()
  const TemporaryStateFilePath = Path.join(
    Path.dirname(StateFilePath),
    `.${Path.basename(StateFilePath)}.${randomUUID()}.tmp`
  )

  for (const [Domain, Entry] of Object.entries(State.Domains)) {
    if (KnownDomains.has(Domain)) {
      Pruned.Domains[Domain] = Entry
    }
  }

  for (const [SourceDomain, Probe] of Object.entries(State.PendingProbes)) {
    if (KnownDomains.has(SourceDomain)) {
      Pruned.PendingProbes[SourceDomain] = Probe
    }
  }

  const Database = await OpenStateDatabase(StateFilePath)
  Fs.mkdirSync(Path.dirname(StateFilePath), { recursive: true })
  try {
    EnsureSchema(Database)
    Database.exec('begin transaction')
    Database.exec('delete from domain_state')
    Database.exec('delete from pending_probe')

    const Statement = Database.prepare('insert into domain_state (domain, last_checked_at, last_verdict, last_warnings_json, modified_at_override) values (?, ?, ?, ?, ?)')
    try {
      for (const [Domain, Entry] of Object.entries(Pruned.Domains).sort(([A], [B]) => A.localeCompare(B))) {
        Statement.run([
          Domain,
          Entry.LastCheckedAt,
          Entry.LastVerdict,
          Entry.LastWarnings ? JSON.stringify(Entry.LastWarnings) : null,
          Entry.ModifiedAtOverride ?? null
        ])
      }
    } finally {
      Statement.free()
    }

    const PendingStatement = Database.prepare('insert into pending_probe (source_domain, target, kind) values (?, ?, ?)')
    try {
      for (const [SourceDomain, Probe] of Object.entries(Pruned.PendingProbes).sort(([A], [B]) => A.localeCompare(B))) {
        PendingStatement.run([SourceDomain, Probe.Target, Probe.Kind])
      }
    } finally {
      PendingStatement.free()
    }

    Database.exec('commit')
    Fs.writeFileSync(TemporaryStateFilePath, Database.export())
    Fs.renameSync(TemporaryStateFilePath, StateFilePath)
  } catch (ErrorValue) {
    try {
      Database.exec('rollback')
    } catch {}

    Fs.rmSync(TemporaryStateFilePath, { force: true })

    throw ErrorValue
  } finally {
    Database.close()
  }
}
