import * as Fs from 'node:fs'
import * as Path from 'node:path'
import * as Process from 'node:process'
import { parseArgs } from 'node:util'
import { DefaultMaxCandidates } from './globalping.ts'
import { ResolvePreviewOutputDirectory } from './preview.ts'

export type LocalOptions = {
  Help: boolean
  Workspace: string
  OutputDirectory: string
  FilterRoot: string
  FileExtension: string
  MaxCandidates: string
  WorkerCount: string
  StatePath: string | null
  AlwaysRefresh: boolean
}

function RequireOption(Value: string | undefined, Name: string): string {
  if (!Value) {
    throw new Error(`${Name} is required`)
  }

  return Value
}

function ParsePositiveInteger(Value: string | undefined, Name: string, DefaultValue: string): string {
  const ResolvedValue = Value ?? DefaultValue
  const NumericValue = Number(ResolvedValue)

  if (!Number.isInteger(NumericValue) || NumericValue <= 0) {
    throw new Error(`${Name} must be a positive integer`)
  }

  return String(NumericValue)
}

export function ParseLocalOptions(Arguments: string[], CurrentDirectory: string): LocalOptions {
  const NormalizedArguments = Arguments[0] === '--' ? Arguments.slice(1) : Arguments
  const Parsed = parseArgs({
    args: NormalizedArguments,
    options: {
      'help': { type: 'boolean', short: 'h', default: false },
      'workspace': { type: 'string' },
      'output': { type: 'string' },
      'filter-root': { type: 'string', default: '.' },
      'file-extension': { type: 'string', default: '.txt' },
      'max-candidates': { type: 'string' },
      'worker-count': { type: 'string' },
      'state-path': { type: 'string' },
      'always-refresh': { type: 'boolean', default: false }
    },
    allowPositionals: false,
    strict: true
  })

  if (Parsed.values.help) {
    return {
      Help: true,
      Workspace: '',
      OutputDirectory: '',
      FilterRoot: '.',
      FileExtension: '.txt',
      MaxCandidates: String(DefaultMaxCandidates),
      WorkerCount: '',
      StatePath: null,
      AlwaysRefresh: false
    }
  }

  const Workspace = Path.resolve(CurrentDirectory, RequireOption(Parsed.values.workspace, '--workspace'))
  const RequestedOutputDirectory = Path.resolve(CurrentDirectory, RequireOption(Parsed.values.output, '--output'))

  if (!Fs.existsSync(Workspace) || !Fs.statSync(Workspace).isDirectory()) {
    throw new Error(`Workspace directory does not exist: ${Workspace}`)
  }

  const StatePath = Parsed.values['state-path'] ? Path.resolve(CurrentDirectory, Parsed.values['state-path']) : null
  const AlwaysRefresh = Parsed.values['always-refresh'] ?? false
  if (AlwaysRefresh && StatePath) {
    throw new Error('--always-refresh cannot be combined with --state-path')
  }

  return {
    Help: false,
    Workspace,
    OutputDirectory: ResolvePreviewOutputDirectory(Workspace, RequestedOutputDirectory),
    FilterRoot: RequireOption(Parsed.values['filter-root'], '--filter-root'),
    FileExtension: RequireOption(Parsed.values['file-extension'], '--file-extension'),
    MaxCandidates: ParsePositiveInteger(Parsed.values['max-candidates'], '--max-candidates', String(DefaultMaxCandidates)),
    WorkerCount: Parsed.values['worker-count']
      ? ParsePositiveInteger(Parsed.values['worker-count'], '--worker-count', '')
      : '',
    StatePath,
    AlwaysRefresh
  }
}

export function ApplyLocalEnvironment(Options: LocalOptions): void {
  Process.env.CI_WORKSPACE_PATH = Options.Workspace
  Process.env.ORDERING_WORKSPACE_PATH = Options.Workspace
  Process.env.PREVIEW_OUTPUT_DIRECTORY = Options.OutputDirectory
  Process.env.FILTER_ROOT = Options.FilterRoot
  Process.env.FILE_EXTENSION = Options.FileExtension
  Process.env.MAX_CANDIDATES = Options.MaxCandidates
  Process.env.WORKER_COUNT = Options.WorkerCount
  Process.env.STATE_DIRECTORY = 'dead-domain-state'
  Process.env.DRY_RUN = 'true'
  Process.env.ALWAYS_REFRESH = String(Options.AlwaysRefresh)
  Process.env.LOCAL_PREVIEW = 'true'
  Process.env.GIT_OPTIONAL_LOCKS = '0'

  if (Options.StatePath) {
    Process.env.SQLITE_STATE_PATH = Options.StatePath
  } else {
    delete Process.env.SQLITE_STATE_PATH
  }
}
