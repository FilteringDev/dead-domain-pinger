import InitSqlJs from 'sql.js'
import * as Fs from 'node:fs'
import { createRequire } from 'node:module'
import * as Path from 'node:path'
import * as Zod from 'zod'
import type { DomainVerdict } from './types.ts'

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
  }))
})

const DomainStateRowSchema = Zod.object({
  domain: Zod.string(),
  last_checked_at: Zod.number(),
  last_verdict: Zod.enum(['Alive', 'Dead', 'Unknown']),
  last_warnings_json: Zod.string().nullable(),
  modified_at_override: Zod.number().nullable()
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
  return { Version: 1, Domains: {} }
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

  for (const [Domain, Entry] of Object.entries(State.Domains)) {
    if (KnownDomains.has(Domain)) {
      Pruned.Domains[Domain] = Entry
    }
  }

  const Database = await OpenStateDatabase(StateFilePath)
  Fs.mkdirSync(Path.dirname(StateFilePath), { recursive: true })
  try {
    EnsureSchema(Database)
    Database.exec('begin transaction')
    Database.exec('delete from domain_state')

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

    Database.exec('commit')
    Fs.writeFileSync(StateFilePath, Database.export())
  } catch (ErrorValue) {
    try {
      Database.exec('rollback')
    } catch {}

    throw ErrorValue
  } finally {
    Database.close()
  }
}
