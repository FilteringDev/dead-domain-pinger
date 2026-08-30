import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { ReportFileName } from './report.ts'

export const DiffFileName = 'dead-domain.diff'

export type PreviewFileChange = {
  FilePath: string
  OriginalContent: string
  ProposedContent: string
}

function IsContainedBy(ParentPath: string, CandidatePath: string): boolean {
  const RelativePath = Path.relative(ParentPath, CandidatePath)

  return RelativePath === '' || (!RelativePath.startsWith(`..${Path.sep}`) && RelativePath !== '..' && !Path.isAbsolute(RelativePath))
}

function ResolvePotentialRealPath(TargetPath: string): string {
  let ExistingPath = TargetPath
  const MissingSegments: string[] = []

  while (!Fs.existsSync(ExistingPath)) {
    const ParentPath = Path.dirname(ExistingPath)
    if (ParentPath === ExistingPath) {
      throw new Error(`Cannot resolve output directory: ${TargetPath}`)
    }

    MissingSegments.unshift(Path.basename(ExistingPath))
    ExistingPath = ParentPath
  }

  return Path.resolve(Fs.realpathSync(ExistingPath), ...MissingSegments)
}

/** Resolves an artifact directory and rejects paths that could write through the target checkout. */
export function ResolvePreviewOutputDirectory(WorkingDirectory: string, RequestedDirectory: string): string {
  const AbsoluteWorkingDirectory = Path.resolve(WorkingDirectory)
  const AbsoluteOutputDirectory = Path.resolve(RequestedDirectory)

  if (!Fs.existsSync(AbsoluteWorkingDirectory) || !Fs.statSync(AbsoluteWorkingDirectory).isDirectory()) {
    throw new Error(`Workspace directory does not exist: ${AbsoluteWorkingDirectory}`)
  }

  if (Fs.existsSync(AbsoluteOutputDirectory) && !Fs.statSync(AbsoluteOutputDirectory).isDirectory()) {
    throw new Error(`Preview output path is not a directory: ${AbsoluteOutputDirectory}`)
  }

  const RealWorkingDirectory = Fs.realpathSync(AbsoluteWorkingDirectory)
  const RealOutputDirectory = ResolvePotentialRealPath(AbsoluteOutputDirectory)

  if (IsContainedBy(AbsoluteWorkingDirectory, AbsoluteOutputDirectory)
    || IsContainedBy(RealWorkingDirectory, RealOutputDirectory)) {
    throw new Error('Preview output directory must be outside the target workspace')
  }

  return AbsoluteOutputDirectory
}

function NormalizeRepositoryPath(FilePath: string): string {
  if (FilePath.includes('\0') || Path.posix.isAbsolute(FilePath) || Path.win32.isAbsolute(FilePath)) {
    throw new Error(`Preview file path must be repository-relative: ${FilePath}`)
  }

  const Normalized = Path.posix.normalize(FilePath.split(Path.sep).join('/'))
  if (Normalized === '.' || Normalized === '..' || Normalized.startsWith('../')) {
    throw new Error(`Preview file path escapes the repository: ${FilePath}`)
  }

  return Normalized
}

function RunPreviewGit(WorkingDirectory: string, Arguments: string[]): string {
  return execFileSync('git', Arguments, {
    cwd: WorkingDirectory,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: Os.devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0'
    },
    maxBuffer: 64 * 1024 * 1024
  })
}

/** Builds a Git-compatible patch without reading from or writing to the target repository. */
export function BuildGitDiff(Changes: PreviewFileChange[]): string {
  const EffectiveChanges = Changes
    .filter(Change => Change.OriginalContent !== Change.ProposedContent)
    .map(Change => ({ ...Change, FilePath: NormalizeRepositoryPath(Change.FilePath) }))
    .sort((Left, Right) => Left.FilePath.localeCompare(Right.FilePath))

  if (EffectiveChanges.length === 0) {
    return ''
  }

  const SeenPaths = new Set<string>()
  for (const Change of EffectiveChanges) {
    if (SeenPaths.has(Change.FilePath)) {
      throw new Error(`Duplicate preview file path: ${Change.FilePath}`)
    }
    SeenPaths.add(Change.FilePath)
  }

  const TemporaryRepository = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-pinger-preview-'))

  try {
    RunPreviewGit(TemporaryRepository, ['init', '--quiet'])
    RunPreviewGit(TemporaryRepository, ['config', 'core.autocrlf', 'false'])
    RunPreviewGit(TemporaryRepository, ['config', 'core.fileMode', 'false'])

    for (const Change of EffectiveChanges) {
      const TemporaryFilePath = Path.join(TemporaryRepository, ...Change.FilePath.split('/'))
      Fs.mkdirSync(Path.dirname(TemporaryFilePath), { recursive: true })
      Fs.writeFileSync(TemporaryFilePath, Change.OriginalContent, 'utf-8')
    }

    RunPreviewGit(TemporaryRepository, ['add', '--all'])

    for (const Change of EffectiveChanges) {
      const TemporaryFilePath = Path.join(TemporaryRepository, ...Change.FilePath.split('/'))
      Fs.writeFileSync(TemporaryFilePath, Change.ProposedContent, 'utf-8')
    }

    return RunPreviewGit(TemporaryRepository, [
      'diff',
      '--no-ext-diff',
      '--text',
      '--no-color',
      '--no-renames',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--'
    ])
  } finally {
    Fs.rmSync(TemporaryRepository, { recursive: true, force: true })
  }
}

function AtomicWriteFile(FilePath: string, Content: string): void {
  const TemporaryFilePath = Path.join(Path.dirname(FilePath), `.${Path.basename(FilePath)}.${randomUUID()}.tmp`)

  try {
    Fs.writeFileSync(TemporaryFilePath, Content, 'utf-8')
    Fs.renameSync(TemporaryFilePath, FilePath)
  } finally {
    Fs.rmSync(TemporaryFilePath, { force: true })
  }
}

/** Writes the only two durable preview artifacts. */
export function WritePreviewArtifacts(OutputDirectory: string, Diff: string, ReportMarkdown: string): void {
  Fs.mkdirSync(OutputDirectory, { recursive: true })
  AtomicWriteFile(Path.join(OutputDirectory, DiffFileName), Diff)
  AtomicWriteFile(Path.join(OutputDirectory, ReportFileName), `${ReportMarkdown.replace(/\n+$/u, '')}\n`)
}
