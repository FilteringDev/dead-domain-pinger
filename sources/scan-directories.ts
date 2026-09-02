import * as Path from 'node:path'
import type { DomainOccurrence } from './types.ts'

function IsWithinDirectory(FilePath: string, Directory: string): boolean {
  const RelativePath = Path.relative(Directory, FilePath)

  return RelativePath === '' || (!RelativePath.startsWith(`..${Path.sep}`) && RelativePath !== '..' && !Path.isAbsolute(RelativePath))
}

/** Parses newline-delimited workspace-relative directories and rejects paths outside the workspace. */
export function ParseScanDirectories(WorkingDirectory: string, Value: string): string[] {
  const Directories = new Set<string>()

  for (const Line of Value.split(/\r?\n/u)) {
    const RequestedDirectory = Line.trim()
    if (!RequestedDirectory) {
      continue
    }

    if (Path.isAbsolute(RequestedDirectory)) {
      throw new Error(`Scan directory must be relative to the workspace: ${RequestedDirectory}`)
    }

    const Directory = Path.resolve(WorkingDirectory, RequestedDirectory)
    if (!IsWithinDirectory(Directory, WorkingDirectory)) {
      throw new Error(`Scan directory must be inside the workspace: ${RequestedDirectory}`)
    }

    Directories.add(Directory)
  }

  return [...Directories]
}

/** Returns occurrences in the configured directory subtrees; an empty directory list includes all occurrences. */
export function FilterOccurrencesByScanDirectories(
  WorkingDirectory: string,
  Occurrences: DomainOccurrence[],
  ScanDirectories: string
): DomainOccurrence[] {
  const Directories = ParseScanDirectories(WorkingDirectory, ScanDirectories)
  if (Directories.length === 0) {
    return Occurrences
  }

  return Occurrences.filter(Occurrence => {
    const FilePath = Path.resolve(WorkingDirectory, Occurrence.FilePath)
    return Directories.some(Directory => IsWithinDirectory(FilePath, Directory))
  })
}