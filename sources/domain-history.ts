import * as ChildProcess from 'node:child_process'
import type { DomainOccurrence } from './types.ts'
import { GetRuleDomains, ParseRule } from './rule-domains.ts'

const CommitSeparator = '\u0000'
// A literal NUL cannot be passed as a process argument, so git has to produce the separator itself.
const CommitSeparatorFormat = '%x00'
const CommitCacheLimit = 128
const StderrLimit = 8 * 1024
const WarningDetailLimit = 512

export type LineBlame = {
  Commit: string
  AuthorTime: number
}

export type GitHistoryFailure = {
  Operation: string
  Message: string
}

export type GitOrderCacheEntry = {
  LineNumber: number
  Domain: string
  ModifiedAt: number
}

type GitOutcome = {
  Succeeded: boolean
  Message: string
}

type GitCompletion = {
  Code: number | null
  Signal: NodeJS.Signals | null
  Error: Error | null
}

type ParsedCommitDiff = {
  Commit: string
  AuthorTime: number
  IntroducedDomains: Set<string>
}

type FallbackOccurrence = {
  Domain: string
  AuthorTime: number
}

type CommitIntroductionCache = Map<string, Set<string>>

export type SeparatedRecordResult = {
  Completed: boolean
  Pending: string
}

function AddFailure(Failures: GitHistoryFailure[], Operation: string, Outcome: GitOutcome): void {
  if (Outcome.Succeeded || Failures.some(Failure => Failure.Operation === Operation)) {
    return
  }

  Failures.push({ Operation, Message: Outcome.Message })
}

function CompletionOf(Child: ChildProcess.ChildProcess): Promise<GitCompletion> {
  return new Promise(Resolve => {
    let Settled = false

    const Finish = (Completion: GitCompletion): void => {
      if (!Settled) {
        Settled = true
        Resolve(Completion)
      }
    }

    Child.once('error', ErrorValue => Finish({ Code: null, Signal: null, Error: ErrorValue }))
    Child.once('close', (Code, Signal) => Finish({ Code, Signal, Error: null }))
  })
}

function DescribeFailure(Completion: GitCompletion, Stderr: string): string {
  const Detail = Stderr.trim().replace(/\s+/gu, ' ').slice(0, WarningDetailLimit)
  if (Completion.Error) {
    return Detail || Completion.Error.message
  }

  const Status = Completion.Signal ? `signal ${Completion.Signal}` : `exit code ${Completion.Code ?? 'unknown'}`
  return Detail ? `${Status}: ${Detail}` : Status
}

/** Consumes complete records as chunks arrive and leaves only the final unfinished record. */
export async function ConsumeSeparatedRecords(
  Chunks: AsyncIterable<string>,
  Separator: string,
  HandleRecord: (Record: string) => boolean | Promise<boolean>
): Promise<SeparatedRecordResult> {
  if (!Separator) {
    throw new Error('Record separator must not be empty')
  }

  let Pending = ''

  for await (const Chunk of Chunks) {
    Pending += String(Chunk)

    for (;;) {
      const SeparatorIndex = Pending.indexOf(Separator)
      if (SeparatorIndex < 0) {
        break
      }

      const Record = Pending.slice(0, SeparatorIndex)
      Pending = Pending.slice(SeparatorIndex + Separator.length)
      if (Record && !(await HandleRecord(Record))) {
        return { Completed: false, Pending: '' }
      }
    }
  }

  return { Completed: true, Pending }
}

/** Streams separator-delimited Git output and never retains more than one unfinished record. */
async function RunGitRecords(
  WorkingDirectory: string,
  GitArguments: string[],
  Separator: string,
  HandleRecord: (Record: string) => boolean | Promise<boolean>
): Promise<GitOutcome> {
  const Child = ChildProcess.spawn('git', GitArguments, {
    cwd: WorkingDirectory,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const CompletionPromise = CompletionOf(Child)
  let Stderr = ''
  let StoppedEarly = false
  let ReadError: Error | null = null
  let Pending = ''

  Child.stderr?.setEncoding('utf-8')
  Child.stderr?.on('data', Chunk => {
    if (Stderr.length < StderrLimit) {
      Stderr += String(Chunk).slice(0, StderrLimit - Stderr.length)
    }
  })

  Child.stdout?.setEncoding('utf-8')
  try {
    const Result = await ConsumeSeparatedRecords(
      (Child.stdout ?? []) as AsyncIterable<string>,
      Separator,
      HandleRecord
    )
    StoppedEarly = !Result.Completed
    Pending = Result.Pending
    if (StoppedEarly) {
      Child.kill()
    }
  } catch (ErrorValue) {
    ReadError = ErrorValue instanceof Error ? ErrorValue : new Error(String(ErrorValue))
    Child.kill()
  }

  const Completion = await CompletionPromise
  if (StoppedEarly) {
    return { Succeeded: true, Message: '' }
  }
  if (ReadError) {
    return { Succeeded: false, Message: ReadError.message }
  }
  if (Completion.Code !== 0) {
    return { Succeeded: false, Message: DescribeFailure(Completion, Stderr) }
  }

  if (Pending && !(await HandleRecord(Pending))) {
    return { Succeeded: true, Message: '' }
  }

  return { Succeeded: true, Message: '' }
}

/** Returns the last commit that changed a clean, tracked file, or null when it cannot be cached. */
export async function GetFileHistoryRevision(WorkingDirectory: string, FilePath: string): Promise<string | null> {
  let Status = ''
  const StatusOutcome = await RunGitRecords(
    WorkingDirectory,
    ['status', '--porcelain', '--', FilePath],
    '\n',
    Line => {
      Status += Line
      return true
    }
  )
  if (!StatusOutcome.Succeeded || Status) {
    return null
  }

  let Revision = ''
  const RevisionOutcome = await RunGitRecords(
    WorkingDirectory,
    ['log', '-n', '1', '--format=%H', '--', FilePath],
    '\n',
    Line => {
      Revision = Line.trim()
      return false
    }
  )

  return RevisionOutcome.Succeeded && /^[0-9a-f]{40}$/u.test(Revision) ? Revision : null
}

/** Adds only domains relevant to the current file, avoiding raw diff-line retention. */
function AddDomainsOfLine(Line: string, RelevantDomains: Set<string>, Domains: Set<string>): void {
  const Rule = ParseRule(Line)
  if (!Rule) {
    return
  }

  for (const Domain of GetRuleDomains(Rule)) {
    if (RelevantDomains.has(Domain)) {
      Domains.add(Domain)
    }
  }
}

function ParseCommitDiff(Block: string, RelevantDomains: Set<string>): ParsedCommitDiff | null {
  const HeaderEnd = Block.indexOf('\n')
  const Header = (HeaderEnd < 0 ? Block : Block.slice(0, HeaderEnd)).trim()
  const HeaderMatch = /^([0-9a-f]+)\s+(\d+)$/u.exec(Header)
  if (!HeaderMatch) {
    return null
  }

  const AuthorTime = Number(HeaderMatch[2])
  if (!Number.isFinite(AuthorTime)) {
    return null
  }

  const BeforeDomains = new Set<string>()
  const AfterDomains = new Set<string>()
  let Start = HeaderEnd < 0 ? Block.length : HeaderEnd + 1

  while (Start <= Block.length) {
    const End = Block.indexOf('\n', Start)
    const Line = Block.slice(Start, End < 0 ? Block.length : End)

    if (Line.startsWith('+') && !Line.startsWith('+++')) {
      AddDomainsOfLine(Line.slice(1), RelevantDomains, AfterDomains)
    } else if (Line.startsWith('-') && !Line.startsWith('---')) {
      AddDomainsOfLine(Line.slice(1), RelevantDomains, BeforeDomains)
    } else if (Line.startsWith(' ')) {
      AddDomainsOfLine(Line.slice(1), RelevantDomains, BeforeDomains)
      AddDomainsOfLine(Line.slice(1), RelevantDomains, AfterDomains)
    }

    if (End < 0) {
      break
    }
    Start = End + 1
  }

  return {
    Commit: HeaderMatch[1],
    AuthorTime,
    IntroducedDomains: new Set([...AfterDomains].filter(Domain => !BeforeDomains.has(Domain)))
  }
}

function FirstLineAtOrAfter(Lines: number[], Target: number): number {
  let Lower = 0
  let Upper = Lines.length

  while (Lower < Upper) {
    const Middle = Math.floor((Lower + Upper) / 2)
    if (Lines[Middle] < Target) {
      Lower = Middle + 1
    } else {
      Upper = Middle
    }
  }

  return Lower
}

/**
 * Maps requested 1-based line numbers to the commit that last touched them.
 * Lines that are not committed yet and files without git history are left out.
 */
export async function GetLineBlame(
  WorkingDirectory: string,
  FilePath: string,
  RequestedLines?: Set<number>,
  Failures: GitHistoryFailure[] = []
): Promise<Map<number, LineBlame>> {
  const Blame = new Map<number, LineBlame>()
  if (RequestedLines?.size === 0) {
    return Blame
  }

  const SortedLines = RequestedLines ? [...RequestedLines].sort((Left, Right) => Left - Right) : null
  const LineArguments = SortedLines?.map(LineNumber => `-L${LineNumber},${LineNumber}`) ?? []
  const AuthorTimes = new Map<string, number>()
  let CurrentCommit = ''
  let CurrentStart = 0
  let CurrentLength = 0
  let CurrentAuthorTime: number | null = null

  const Outcome = await RunGitRecords(
    WorkingDirectory,
    ['blame', '--incremental', ...LineArguments, '--', FilePath],
    '\n',
    Line => {
      const HeaderMatch = /^([0-9a-f]+)\s+\d+\s+(\d+)\s+(\d+)$/u.exec(Line)
      if (HeaderMatch) {
        CurrentCommit = HeaderMatch[1]
        CurrentStart = Number(HeaderMatch[2])
        CurrentLength = Number(HeaderMatch[3])
        CurrentAuthorTime = AuthorTimes.get(CurrentCommit) ?? null
        return true
      }

      if (Line.startsWith('author-time ')) {
        const AuthorTime = Number(Line.slice('author-time '.length).trim())
        if (Number.isFinite(AuthorTime)) {
          CurrentAuthorTime = AuthorTime
          AuthorTimes.set(CurrentCommit, AuthorTime)
        }
        return true
      }

      if (!Line.startsWith('filename ') || !CurrentCommit || /^0+$/u.test(CurrentCommit) || CurrentAuthorTime === null) {
        return true
      }

      const End = CurrentStart + CurrentLength
      if (SortedLines) {
        for (let Index = FirstLineAtOrAfter(SortedLines, CurrentStart); Index < SortedLines.length && SortedLines[Index] < End; Index += 1) {
          Blame.set(SortedLines[Index], { Commit: CurrentCommit, AuthorTime: CurrentAuthorTime })
        }
      } else {
        for (let LineNumber = CurrentStart; LineNumber < End; LineNumber += 1) {
          Blame.set(LineNumber, { Commit: CurrentCommit, AuthorTime: CurrentAuthorTime })
        }
      }

      return SortedLines ? Blame.size < SortedLines.length : true
    }
  )

  AddFailure(Failures, 'blame', Outcome)
  return Outcome.Succeeded ? Blame : new Map()
}

/** Domains introduced by one commit, filtered to the supplied file-domain set when provided. */
export async function GetCommitIntroducedDomains(
  WorkingDirectory: string,
  Commit: string,
  FilePath: string,
  RelevantDomains?: Set<string>,
  Failures: GitHistoryFailure[] = []
): Promise<Set<string>> {
  const IntroducedDomains = new Set<string>()
  const Domains = RelevantDomains ?? new Set<string>()
  let SawDiff = false

  const Outcome = await RunGitRecords(
    WorkingDirectory,
    ['show', `--format=${CommitSeparatorFormat}%H %at`, '--no-color', '-U0', Commit, '--', FilePath],
    CommitSeparator,
    Block => {
      if (!Block.trim()) {
        return true
      }

      if (!RelevantDomains) {
        // The unfiltered exported path first discovers domains from the diff, then reparses it.
        let Start = Block.indexOf('\n') + 1
        while (Start > 0 && Start <= Block.length) {
          const End = Block.indexOf('\n', Start)
          const Line = Block.slice(Start, End < 0 ? Block.length : End)
          if ((Line.startsWith('+') && !Line.startsWith('+++'))
            || (Line.startsWith('-') && !Line.startsWith('---'))
            || Line.startsWith(' ')) {
            const Rule = ParseRule(Line.slice(1))
            if (Rule) {
              for (const Domain of GetRuleDomains(Rule)) {
                Domains.add(Domain)
              }
            }
          }
          if (End < 0) {
            break
          }
          Start = End + 1
        }
      }

      const Diff = ParseCommitDiff(Block, Domains)
      if (Diff) {
        SawDiff = true
        for (const Domain of Diff.IntroducedDomains) {
          IntroducedDomains.add(Domain)
        }
      }
      return true
    }
  )

  AddFailure(Failures, 'commit diff', Outcome)
  return Outcome.Succeeded && SawDiff ? IntroducedDomains : new Set()
}

async function GetLineIntroductionTimes(
  WorkingDirectory: string,
  FilePath: string,
  LineNumber: number,
  Domains: Set<string>,
  IntroducedDomainsOf: (Commit: string) => Promise<Set<string>>,
  Failures: GitHistoryFailure[]
): Promise<Map<string, number>> {
  const IntroductionTimes = new Map<string, number>()
  const RemainingDomains = new Set(Domains)

  const Outcome = await RunGitRecords(
    WorkingDirectory,
    ['log', `-L${LineNumber},${LineNumber}:${FilePath}`, `--format=${CommitSeparatorFormat}%H %at`, '--no-color'],
    CommitSeparator,
    async Block => {
      const Diff = ParseCommitDiff(Block, RemainingDomains)
      if (!Diff || Diff.IntroducedDomains.size === 0) {
        return true
      }

      const FileIntroductions = await IntroducedDomainsOf(Diff.Commit)
      for (const Domain of Diff.IntroducedDomains) {
        // A commit that only moved the domain into this line does not count as a modification.
        if (FileIntroductions.has(Domain)) {
          IntroductionTimes.set(Domain, Diff.AuthorTime)
          RemainingDomains.delete(Domain)
        }
      }

      return RemainingDomains.size > 0
    }
  )

  AddFailure(Failures, 'line history', Outcome)
  return Outcome.Succeeded ? IntroductionTimes : new Map()
}

/** Newest commit that brought each requested domain into a file, over its whole history. */
async function GetFileIntroductionTimes(
  WorkingDirectory: string,
  FilePath: string,
  Domains: Set<string>,
  Failures: GitHistoryFailure[]
): Promise<Map<string, number>> {
  const IntroductionTimes = new Map<string, number>()
  const RemainingDomains = new Set(Domains)

  const Outcome = await RunGitRecords(
    WorkingDirectory,
    ['log', `--format=${CommitSeparatorFormat}%H %at`, '--no-color', '-U0', '-p', '--', FilePath],
    CommitSeparator,
    Block => {
      const Diff = ParseCommitDiff(Block, RemainingDomains)
      if (!Diff) {
        return true
      }

      for (const Domain of Diff.IntroducedDomains) {
        IntroductionTimes.set(Domain, Diff.AuthorTime)
        RemainingDomains.delete(Domain)
      }

      return RemainingDomains.size > 0
    }
  )

  AddFailure(Failures, 'file history', Outcome)
  return Outcome.Succeeded ? IntroductionTimes : new Map()
}

function SetNewestTime(ModifiedTimes: Map<string, number>, Domain: string, ModifiedAt: number): void {
  ModifiedTimes.set(Domain, Math.max(ModifiedTimes.get(Domain) ?? ModifiedAt, ModifiedAt))
}

function ReadCachedIntroduction(Cache: CommitIntroductionCache, Commit: string): Set<string> | null {
  const Cached = Cache.get(Commit)
  if (!Cached) {
    return null
  }

  Cache.delete(Commit)
  Cache.set(Commit, Cached)
  return Cached
}

function WriteCachedIntroduction(Cache: CommitIntroductionCache, Commit: string, Domains: Set<string>): void {
  Cache.set(Commit, Domains)
  if (Cache.size <= CommitCacheLimit) {
    return
  }

  const OldestCommit = Cache.keys().next().value
  if (OldestCommit !== undefined) {
    Cache.delete(OldestCommit)
  }
}

/** Resolves the last time each domain of a single file was introduced or changed by a commit. */
export async function GetDomainModifiedTimes(
  WorkingDirectory: string,
  FilePath: string,
  Occurrences: DomainOccurrence[],
  FallbackAuthorTime: number,
  Failures: GitHistoryFailure[] = [],
  CachedEntries: GitOrderCacheEntry[] = []
): Promise<Map<string, number>> {
  const DomainsByLine = new Map<number, Set<string>>()
  const CachedModifiedTimes = new Map<string, number>()
  const RelevantDomains = new Set<string>()
  for (const Occurrence of Occurrences) {
    RelevantDomains.add(Occurrence.Domain)
    const LineDomains = DomainsByLine.get(Occurrence.LineNumber) ?? new Set<string>()
    LineDomains.add(Occurrence.Domain)
    DomainsByLine.set(Occurrence.LineNumber, LineDomains)
  }

  for (const Entry of CachedEntries) {
    if (DomainsByLine.get(Entry.LineNumber)?.has(Entry.Domain)) {
      CachedModifiedTimes.set(`${Entry.LineNumber}\u0000${Entry.Domain}`, Entry.ModifiedAt)
    }
  }

  const UncachedLines = new Set<number>()
  for (const [LineNumber, Domains] of DomainsByLine) {
    if ([...Domains].some(Domain => !CachedModifiedTimes.has(`${LineNumber}\u0000${Domain}`))) {
      UncachedLines.add(LineNumber)
    }
  }

  const Blame = await GetLineBlame(WorkingDirectory, FilePath, UncachedLines, Failures)
  const IntroducedDomainsByCommit: CommitIntroductionCache = new Map()
  const ModifiedTimes = new Map<string, number>()
  const FallbackOccurrences: FallbackOccurrence[] = []

  const IntroducedDomainsOf = async (Commit: string): Promise<Set<string>> => {
    const Cached = ReadCachedIntroduction(IntroducedDomainsByCommit, Commit)
    if (Cached) {
      return Cached
    }

    const IntroducedDomains = await GetCommitIntroducedDomains(
      WorkingDirectory,
      Commit,
      FilePath,
      RelevantDomains,
      Failures
    )
    WriteCachedIntroduction(IntroducedDomainsByCommit, Commit, IntroducedDomains)
    return IntroducedDomains
  }

  for (const [LineNumber, Domains] of DomainsByLine) {
    const RemainingDomains = new Set<string>()
    for (const Domain of Domains) {
      const CachedModifiedAt = CachedModifiedTimes.get(`${LineNumber}\u0000${Domain}`)
      if (CachedModifiedAt === undefined) {
        RemainingDomains.add(Domain)
      } else {
        SetNewestTime(ModifiedTimes, Domain, CachedModifiedAt)
      }
    }
    if (RemainingDomains.size === 0) {
      continue
    }

    const LineBlameEntry = Blame.get(LineNumber)
    if (!LineBlameEntry) {
      for (const Domain of RemainingDomains) {
        SetNewestTime(ModifiedTimes, Domain, FallbackAuthorTime)
      }
      continue
    }

    const BlameIntroductions = await IntroducedDomainsOf(LineBlameEntry.Commit)
    for (const Domain of RemainingDomains) {
      if (BlameIntroductions.has(Domain)) {
        SetNewestTime(ModifiedTimes, Domain, LineBlameEntry.AuthorTime)
        RemainingDomains.delete(Domain)
      }
    }

    if (RemainingDomains.size > 0) {
      const LineIntroductionTimes = await GetLineIntroductionTimes(
        WorkingDirectory,
        FilePath,
        LineNumber,
        RemainingDomains,
        IntroducedDomainsOf,
        Failures
      )

      for (const Domain of RemainingDomains) {
        const IntroductionTime = LineIntroductionTimes.get(Domain)
        if (IntroductionTime === undefined) {
          FallbackOccurrences.push({ Domain, AuthorTime: LineBlameEntry.AuthorTime })
        } else {
          SetNewestTime(ModifiedTimes, Domain, IntroductionTime)
        }
      }
    }
  }

  if (FallbackOccurrences.length > 0) {
    const FallbackDomains = new Set(FallbackOccurrences.map(Occurrence => Occurrence.Domain))
    const FileIntroductionTimes = await GetFileIntroductionTimes(WorkingDirectory, FilePath, FallbackDomains, Failures)
    for (const Occurrence of FallbackOccurrences) {
      SetNewestTime(
        ModifiedTimes,
        Occurrence.Domain,
        FileIntroductionTimes.get(Occurrence.Domain) ?? Occurrence.AuthorTime
      )
    }
  }

  return ModifiedTimes
}

export async function IsShallowRepository(WorkingDirectory: string): Promise<boolean> {
  let Result = ''
  const Outcome = await RunGitRecords(
    WorkingDirectory,
    ['rev-parse', '--is-shallow-repository'],
    '\n',
    Line => {
      Result = Line.trim()
      return false
    }
  )

  return Outcome.Succeeded && Result === 'true'
}
