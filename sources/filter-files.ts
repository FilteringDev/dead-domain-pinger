import * as Fs from 'node:fs'
import * as Path from 'node:path'

const RotatingFileSuffix = '.rotating.txt'
const IgnoredDirectoryNames = new Set(['node_modules', '.git'])

export type ListFilterFilesOptions = {
  /** Directory to scan, relative to the working directory. Defaults to the working directory itself. */
  RootDirectory?: string
  /** File extension (with leading dot) that filter list files use. Defaults to `.txt`. */
  FileExtension?: string
  /** Root-relative filenames to always skip, e.g. generated bundles. */
  IgnoredRootFiles?: RegExp
}

function IsIgnoredRootFile(RelativePath: string, Pattern: RegExp | undefined): boolean {
  if (!Pattern) {
    return false
  }

  const Segments = RelativePath.split(Path.sep)

  return Segments.length === 1 && Pattern.test(Segments[0])
}

function CollectRecursively(AbsoluteDirectory: string, BaseDirectory: string, FileExtension: string, IgnoredRootFiles: RegExp | undefined, Collected: string[]): void {
  const Entries = Fs.readdirSync(AbsoluteDirectory, { withFileTypes: true })

  for (const Entry of Entries) {
    const AbsoluteEntryPath = Path.join(AbsoluteDirectory, Entry.name)

    if (Entry.isDirectory()) {
      if (IgnoredDirectoryNames.has(Entry.name)) {
        continue
      }

      CollectRecursively(AbsoluteEntryPath, BaseDirectory, FileExtension, IgnoredRootFiles, Collected)
      continue
    }

    if (!Entry.isFile() || !Entry.name.endsWith(FileExtension)) {
      continue
    }

    if (Entry.name.endsWith(RotatingFileSuffix)) {
      continue
    }

    const RelativePath = Path.relative(BaseDirectory, AbsoluteEntryPath)
    if (IsIgnoredRootFile(RelativePath, IgnoredRootFiles)) {
      continue
    }

    Collected.push(RelativePath)
  }
}

/** Returns repository-relative paths of every loadable filter list file, sorted for stable output. */
export function ListFilterFiles(WorkingDirectory: string, Options: ListFilterFilesOptions = {}): string[] {
  const RootDirectory = Path.resolve(WorkingDirectory, Options.RootDirectory ?? '.')
  const FileExtension = Options.FileExtension ?? '.txt'

  if (!Fs.existsSync(RootDirectory)) {
    return []
  }

  const Collected: string[] = []
  CollectRecursively(RootDirectory, WorkingDirectory, FileExtension, Options.IgnoredRootFiles, Collected)

  return Collected.sort((A, B) => A.localeCompare(B))
}
