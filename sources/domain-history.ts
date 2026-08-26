import * as ChildProcess from 'node:child_process'
import type { DomainOccurrence } from './types.ts'
import { GetRuleDomains, ParseRule } from './rule-domains.ts'

const GitMaxBuffer = 256 * 1024 * 1024
const UncommittedCommit = '0'.repeat(40)
const CommitSeparator = '\u0000'
// A literal NUL cannot be passed as a process argument, so git has to produce the separator itself.
const CommitSeparatorFormat = '%x00'

export type LineBlame = {
  Commit: string
  AuthorTime: number
}

function RunGit(WorkingDirectory: string, Arguments: string[]): string | null {
  try {
    return ChildProcess.execFileSync('git', Arguments, {
      cwd: WorkingDirectory,
      encoding: 'utf-8',
      maxBuffer: GitMaxBuffer,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return null
  }
}

/** Domains referenced by raw filter list lines, ignoring anything that does not parse as a rule. */
function GetDomainsOfLines(Lines: string[]): Set<string> {
  const Domains = new Set<string>()

  for (const Line of Lines) {
    const Rule = ParseRule(Line)
    if (!Rule) {
      continue
    }

    for (const Domain of GetRuleDomains(Rule)) {
      Domains.add(Domain)
    }
  }

  return Domains
}

/**
 * Maps 1-based line numbers of a file to the commit that last touched them.
 * Lines that are not committed yet and files without git history are left out.
 */
export function GetLineBlame(WorkingDirectory: string, FilePath: string): Map<number, LineBlame> {
  const Blame = new Map<number, LineBlame>()
  const BlameOutput = RunGit(WorkingDirectory, ['blame', '--line-porcelain', '--', FilePath])
  if (BlameOutput === null) {
    return Blame
  }

  let CurrentLineNumber = 0
  let CurrentCommit = ''

  for (const Line of BlameOutput.split('\n')) {
    const HeaderMatch = /^([0-9a-f]{40})\s+\d+\s+(\d+)(?:\s+\d+)?$/.exec(Line)
    if (HeaderMatch) {
      CurrentCommit = HeaderMatch[1]
      CurrentLineNumber = Number(HeaderMatch[2])
      continue
    }

    if (CurrentLineNumber > 0 && CurrentCommit !== UncommittedCommit && Line.startsWith('author-time ')) {
      const AuthorTime = Number(Line.slice('author-time '.length).trim())
      if (Number.isFinite(AuthorTime)) {
        Blame.set(CurrentLineNumber, { Commit: CurrentCommit, AuthorTime })
      }
    }
  }

  return Blame
}

type CommitDiff = {
  Commit: string
  AuthorTime: number
  BeforeLines: string[]
  AfterLines: string[]
}

function ParseCommitDiffs(LogOutput: string): CommitDiff[] {
  const Diffs: CommitDiff[] = []

  for (const Block of LogOutput.split(CommitSeparator).slice(1)) {
    const Lines = Block.split('\n')
    const [Commit, RawAuthorTime] = Lines[0].trim().split(' ')
    const AuthorTime = Number(RawAuthorTime)
    if (!Number.isFinite(AuthorTime)) {
      continue
    }

    const Diff: CommitDiff = { Commit, AuthorTime, BeforeLines: [], AfterLines: [] }

    for (const Line of Lines.slice(1)) {
      if (Line.startsWith('+') && !Line.startsWith('+++')) {
        Diff.AfterLines.push(Line.slice(1))
      } else if (Line.startsWith('-') && !Line.startsWith('---')) {
        Diff.BeforeLines.push(Line.slice(1))
      } else if (Line.startsWith(' ')) {
        Diff.BeforeLines.push(Line.slice(1))
        Diff.AfterLines.push(Line.slice(1))
      }
    }

    Diffs.push(Diff)
  }

  return Diffs
}

/**
 * Domains a diff really brought in. Domains that only moved around within the same commit are
 * excluded, so adding one domain to an existing rule does not refresh its neighbours.
 */
function GetIntroducedDomains(Diff: CommitDiff): Set<string> {
  const BeforeDomains = GetDomainsOfLines(Diff.BeforeLines)

  return new Set([...GetDomainsOfLines(Diff.AfterLines)].filter(Domain => !BeforeDomains.has(Domain)))
}

export function GetCommitIntroducedDomains(WorkingDirectory: string, Commit: string, FilePath: string): Set<string> {
  const ShowOutput = RunGit(WorkingDirectory, ['show', `--format=${CommitSeparatorFormat}%H %at`, '--no-color', '-U0', Commit, '--', FilePath])
  const Diff = ShowOutput === null ? undefined : ParseCommitDiffs(ShowOutput)[0]

  return Diff ? GetIntroducedDomains(Diff) : new Set()
}

/** History of a single line, newest first, back to the commit that created it. */
function GetLineHistory(WorkingDirectory: string, FilePath: string, LineNumber: number): CommitDiff[] {
  const LogOutput = RunGit(WorkingDirectory, ['log', `-L${LineNumber},${LineNumber}:${FilePath}`, `--format=${CommitSeparatorFormat}%H %at`, '--no-color'])

  return LogOutput === null ? [] : ParseCommitDiffs(LogOutput)
}

/** Newest commit that brought each domain into a file, over the whole history of that file. */
function GetFileIntroductionTimes(WorkingDirectory: string, FilePath: string): Map<string, number> {
  const IntroductionTimes = new Map<string, number>()
  const LogOutput = RunGit(WorkingDirectory, ['log', `--format=${CommitSeparatorFormat}%H %at`, '--no-color', '-U0', '-p', '--', FilePath])
  if (LogOutput === null) {
    return IntroductionTimes
  }

  for (const Diff of ParseCommitDiffs(LogOutput)) {
    for (const Domain of GetIntroducedDomains(Diff)) {
      if (!IntroductionTimes.has(Domain)) {
        IntroductionTimes.set(Domain, Diff.AuthorTime)
      }
    }
  }

  return IntroductionTimes
}

/** Resolves the last time each domain of a single file was introduced or changed by a commit. */
export function GetDomainModifiedTimes(
  WorkingDirectory: string,
  FilePath: string,
  Occurrences: DomainOccurrence[],
  FallbackAuthorTime: number
): Map<string, number> {
  const Blame = GetLineBlame(WorkingDirectory, FilePath)
  const IntroducedDomainsByCommit = new Map<string, Set<string>>()
  const ModifiedTimes = new Map<string, number>()
  let FileIntroductionTimes: Map<string, number> | null = null

  const IntroducedDomainsOf = (Commit: string): Set<string> => {
    let IntroducedDomains = IntroducedDomainsByCommit.get(Commit)
    if (!IntroducedDomains) {
      IntroducedDomains = GetCommitIntroducedDomains(WorkingDirectory, Commit, FilePath)
      IntroducedDomainsByCommit.set(Commit, IntroducedDomains)
    }

    return IntroducedDomains
  }

  const ResolveModifiedAt = (Occurrence: DomainOccurrence, LineBlameEntry: LineBlame): number => {
    if (IntroducedDomainsOf(LineBlameEntry.Commit).has(Occurrence.Domain)) {
      return LineBlameEntry.AuthorTime
    }

    for (const Diff of GetLineHistory(WorkingDirectory, FilePath, Occurrence.LineNumber)) {
      // A commit that only moved the domain into this line does not count as a modification.
      if (GetIntroducedDomains(Diff).has(Occurrence.Domain) && IntroducedDomainsOf(Diff.Commit).has(Occurrence.Domain)) {
        return Diff.AuthorTime
      }
    }

    FileIntroductionTimes ??= GetFileIntroductionTimes(WorkingDirectory, FilePath)

    return FileIntroductionTimes.get(Occurrence.Domain) ?? LineBlameEntry.AuthorTime
  }

  for (const Occurrence of Occurrences) {
    const LineBlameEntry = Blame.get(Occurrence.LineNumber)
    const ModifiedAt = LineBlameEntry ? ResolveModifiedAt(Occurrence, LineBlameEntry) : FallbackAuthorTime

    ModifiedTimes.set(Occurrence.Domain, Math.max(ModifiedTimes.get(Occurrence.Domain) ?? ModifiedAt, ModifiedAt))
  }

  return ModifiedTimes
}

export function IsShallowRepository(WorkingDirectory: string): boolean {
  return RunGit(WorkingDirectory, ['rev-parse', '--is-shallow-repository'])?.trim() === 'true'
}
