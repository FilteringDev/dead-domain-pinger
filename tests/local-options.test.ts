import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import * as Process from 'node:process'
import { expect, test } from 'vitest'
import { ApplyLocalEnvironment, ParseLocalOptions } from '../sources/local-options.ts'

function CreatePaths(): { RootDirectory: string, WorkingDirectory: string, OutputDirectory: string } {
  const RootDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-local-options-'))
  const WorkingDirectory = Path.join(RootDirectory, 'workspace')
  const OutputDirectory = Path.join(RootDirectory, 'preview')
  Fs.mkdirSync(WorkingDirectory)

  return { RootDirectory, WorkingDirectory, OutputDirectory }
}

test('ParseLocalOptions accepts the pnpm separator and provides local defaults', () => {
  const Paths = CreatePaths()
  const StatePath = Path.join(Paths.RootDirectory, 'state.sqlite')
  const Options = ParseLocalOptions([
    '--',
    '--workspace', Paths.WorkingDirectory,
    '--output', Paths.OutputDirectory,
    '--state-path', StatePath
  ], Paths.RootDirectory)

  expect(Options).toMatchObject({
    Help: false,
    Workspace: Paths.WorkingDirectory,
    OutputDirectory: Paths.OutputDirectory,
    FilterRoot: '.',
    ScanDirectories: '',
    FileExtension: '.txt',
    MaxCandidates: '50',
    WorkerCount: '',
    OrderingWorkerCount: '',
    StatePath
  })
})

test('ParseLocalOptions handles tuning flags', () => {
  const Paths = CreatePaths()
  const StatePath = Path.join(Paths.RootDirectory, 'state.sqlite')
  const Options = ParseLocalOptions([
    '--workspace', Paths.WorkingDirectory,
    '--output', Paths.OutputDirectory,
    '--filter-root', 'filters',
    '--scan-directories', 'filters/ads\nfilters/privacy',
    '--file-extension', '.list',
    '--max-candidates', '12',
    '--worker-count', '3',
    '--ordering-worker-count', '2',
    '--state-path', StatePath
  ], Paths.RootDirectory)

  expect(Options).toMatchObject({
    FilterRoot: 'filters',
    ScanDirectories: 'filters/ads\nfilters/privacy',
    FileExtension: '.list',
    MaxCandidates: '12',
    WorkerCount: '3',
    OrderingWorkerCount: '2',
    StatePath
  })

})

test('ParseLocalOptions rejects missing paths, invalid counts and checkout-contained output', () => {
  const Paths = CreatePaths()

  expect(() => ParseLocalOptions([], Paths.RootDirectory)).toThrow('--workspace is required')
  expect(() => ParseLocalOptions([
    '--workspace', Paths.WorkingDirectory,
    '--output', Paths.OutputDirectory
  ], Paths.RootDirectory)).toThrow('--state-path is required')
  expect(() => ParseLocalOptions([
    '--workspace', Paths.WorkingDirectory,
    '--output', Paths.OutputDirectory,
    '--state-path', Path.join(Paths.RootDirectory, 'state.sqlite'),
    '--max-candidates', '0'
  ], Paths.RootDirectory)).toThrow('--max-candidates must be a positive integer')
  expect(() => ParseLocalOptions([
    '--workspace', Paths.WorkingDirectory,
    '--output', Paths.OutputDirectory,
    '--state-path', Path.join(Paths.RootDirectory, 'state.sqlite'),
    '--ordering-worker-count', '0'
  ], Paths.RootDirectory)).toThrow('--ordering-worker-count must be a positive integer')
  expect(() => ParseLocalOptions([
    '--workspace', Paths.WorkingDirectory,
    '--output', Path.join(Paths.WorkingDirectory, 'preview'),
    '--state-path', Path.join(Paths.RootDirectory, 'state.sqlite')
  ], Paths.RootDirectory)).toThrow('outside the target workspace')
})

test('ApplyLocalEnvironment forces preview mode and configures the state cache', () => {
  const Paths = CreatePaths()
  const PreviousEnvironment = { ...Process.env }

  try {
    Process.env.SQLITE_STATE_PATH = '/previous/state.sqlite'
    const Options = ParseLocalOptions([
      '--workspace', Paths.WorkingDirectory,
      '--output', Paths.OutputDirectory,
      '--state-path', Path.join(Paths.RootDirectory, 'state.sqlite')
    ], Paths.RootDirectory)

    ApplyLocalEnvironment(Options)

    expect(Process.env.DRY_RUN).toBe('true')
    expect(Process.env.ALWAYS_REFRESH).toBe('false')
    expect(Process.env.LOCAL_PREVIEW).toBe('true')
    expect(Process.env.SQLITE_STATE_PATH).toBe(Path.join(Paths.RootDirectory, 'state.sqlite'))
    expect(Process.env.GIT_OPTIONAL_LOCKS).toBe('0')
    expect(Process.env.ORDERING_WORKER_COUNT).toBe('')
    expect(Process.env.SCAN_DIRECTORIES).toBe('')
  } finally {
    for (const Name of Object.keys(Process.env)) {
      if (!(Name in PreviousEnvironment)) {
        delete Process.env[Name]
      }
    }
    Object.assign(Process.env, PreviousEnvironment)
  }
})

test('ParseLocalOptions shows help without requiring paths', () => {
  expect(ParseLocalOptions(['--', '--help'], Process.cwd()).Help).toBe(true)
})
