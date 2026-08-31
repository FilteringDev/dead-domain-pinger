import * as Fs from 'node:fs'
import * as Path from 'node:path'
import type { DomainOccurrence } from './types.ts'
import { GetRuleDomainOrigins, ParseRule, SplitLines } from './rule-domains.ts'

/** Extracts every domain occurrence of a single filter list file, keeping 1-based line numbers. */
export function CollectDomainOccurrencesFromContent(FilePath: string, Content: string): DomainOccurrence[] {
  const Occurrences: DomainOccurrence[] = []
  const Lines = SplitLines(Content)

  for (let Index = 0; Index < Lines.length; Index += 1) {
    const Rule = ParseRule(Lines[Index].Text)
    if (!Rule) {
      continue
    }

    for (const Reference of GetRuleDomainOrigins(Rule)) {
      Occurrences.push({
        Domain: Reference.Domain,
        FilePath,
        LineNumber: Index + 1,
        Origin: Reference.Origin
      })
    }
  }

  return Occurrences
}

export function CollectDomainOccurrences(WorkingDirectory: string, FilePaths: string[]): DomainOccurrence[] {
  const Occurrences: DomainOccurrence[] = []

  for (const FilePath of FilePaths) {
    const Content = Fs.readFileSync(Path.resolve(WorkingDirectory, FilePath), 'utf-8')
    Occurrences.push(...CollectDomainOccurrencesFromContent(FilePath, Content))
  }

  return Occurrences
}
