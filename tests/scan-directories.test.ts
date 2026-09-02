import * as Path from 'node:path'
import { expect, test } from 'vitest'
import { FilterOccurrencesByScanDirectories, ParseScanDirectories } from '../sources/scan-directories.ts'
import type { DomainOccurrence } from '../sources/types.ts'

const WorkingDirectory = '/workspace'
const Occurrences: DomainOccurrence[] = [
  { Domain: 'root.example', FilePath: 'root.txt', LineNumber: 1, Origin: 'domainList' },
  { Domain: 'lists.example', FilePath: 'lists/main.txt', LineNumber: 1, Origin: 'domainList' },
  { Domain: 'nested.example', FilePath: 'lists/ads/main.txt', LineNumber: 1, Origin: 'domainList' },
  { Domain: 'backup.example', FilePath: 'lists-backup/main.txt', LineNumber: 1, Origin: 'domainList' },
  { Domain: 'other.example', FilePath: 'other/main.txt', LineNumber: 1, Origin: 'domainList' }
]

test('an empty scan directory list includes all occurrences', () => {
  expect(FilterOccurrencesByScanDirectories(WorkingDirectory, Occurrences, '')).toBe(Occurrences)
})

test('a scan directory includes its descendant files but not sibling prefixes', () => {
  const Result = FilterOccurrencesByScanDirectories(WorkingDirectory, Occurrences, 'lists')

  expect(Result.map(Occurrence => Occurrence.Domain)).toEqual(['lists.example', 'nested.example'])
})

test('multiple scan directories include each selected subtree', () => {
  const Result = FilterOccurrencesByScanDirectories(WorkingDirectory, Occurrences, 'lists/ads\nother')

  expect(Result.map(Occurrence => Occurrence.Domain)).toEqual(['nested.example', 'other.example'])
})

test('scan directories normalize separators, trailing slashes and duplicates', () => {
  const Value = `lists${Path.sep}ads${Path.sep}\nlists/ads\n`

  expect(ParseScanDirectories(WorkingDirectory, Value)).toEqual([Path.join(WorkingDirectory, 'lists', 'ads')])
})

test('scan directories outside the workspace are rejected', () => {
  expect(() => ParseScanDirectories(WorkingDirectory, '../outside')).toThrow('inside the workspace')
  expect(() => ParseScanDirectories(WorkingDirectory, Path.join(WorkingDirectory, 'lists'))).toThrow('relative to the workspace')
})