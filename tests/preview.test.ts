import { execFileSync } from 'node:child_process'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import { expect, test } from 'vitest'
import { BuildGitDiff, DiffFileName, ResolvePreviewOutputDirectory, WritePreviewArtifacts } from '../sources/preview.ts'
import { ReportFileName } from '../sources/report.ts'

test('BuildGitDiff creates a deterministic applyable patch without changing source files', () => {
  const WorkingDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-preview-target-'))
  const Changes = [
    {
      FilePath: 'z-list.txt',
      OriginalContent: 'local edit\nold value\n',
      ProposedContent: 'local edit\nnew value\n'
    },
    {
      FilePath: 'filters/a-list.txt',
      OriginalContent: 'remove me\nkeep me\n',
      ProposedContent: 'keep me\n'
    }
  ]

  for (const Change of Changes) {
    const FilePath = Path.join(WorkingDirectory, Change.FilePath)
    Fs.mkdirSync(Path.dirname(FilePath), { recursive: true })
    Fs.writeFileSync(FilePath, Change.OriginalContent, 'utf-8')
  }

  const Diff = BuildGitDiff(Changes)
  const PatchFilePath = Path.join(WorkingDirectory, 'preview.diff')
  Fs.writeFileSync(PatchFilePath, Diff, 'utf-8')

  expect(Diff).toBe(BuildGitDiff([...Changes].reverse()))
  expect(Diff).toContain('diff --git a/filters/a-list.txt b/filters/a-list.txt')
  expect(Diff).toContain('diff --git a/z-list.txt b/z-list.txt')
  expect(Diff.indexOf('a/filters/a-list.txt')).toBeLessThan(Diff.indexOf('a/z-list.txt'))
  expect(Fs.readFileSync(Path.join(WorkingDirectory, 'z-list.txt'), 'utf-8')).toBe('local edit\nold value\n')
  execFileSync('git', ['apply', '--check', PatchFilePath], { cwd: WorkingDirectory })
})

test('BuildGitDiff preserves CRLF content and returns an empty patch for no changes', () => {
  const Diff = BuildGitDiff([{
    FilePath: 'filters/list.txt',
    OriginalContent: 'first\r\nold\r\n',
    ProposedContent: 'first\r\nnew\r\n'
  }])

  expect(Diff).toContain('-old\r\n+new\r\n')
  expect(BuildGitDiff([])).toBe('')
  expect(BuildGitDiff([{
    FilePath: 'filters/list.txt',
    OriginalContent: 'same\n',
    ProposedContent: 'same\n'
  }])).toBe('')
})

test('BuildGitDiff rejects paths that escape the repository', () => {
  expect(() => BuildGitDiff([{
    FilePath: '../outside.txt',
    OriginalContent: 'old\n',
    ProposedContent: 'new\n'
  }])).toThrow('escapes the repository')
})

test('ResolvePreviewOutputDirectory rejects direct and symlink paths into the workspace', () => {
  const RootDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-preview-paths-'))
  const WorkingDirectory = Path.join(RootDirectory, 'workspace')
  const ExternalDirectory = Path.join(RootDirectory, 'output')
  Fs.mkdirSync(WorkingDirectory)
  Fs.mkdirSync(ExternalDirectory)

  expect(ResolvePreviewOutputDirectory(WorkingDirectory, ExternalDirectory)).toBe(ExternalDirectory)
  expect(() => ResolvePreviewOutputDirectory(WorkingDirectory, Path.join(WorkingDirectory, 'output')))
    .toThrow('outside the target workspace')

  const LinkPath = Path.join(RootDirectory, 'workspace-link')
  Fs.symlinkSync(WorkingDirectory, LinkPath, 'dir')
  expect(() => ResolvePreviewOutputDirectory(WorkingDirectory, Path.join(LinkPath, 'output')))
    .toThrow('outside the target workspace')
})

test('WritePreviewArtifacts writes only the diff and full report files', () => {
  const OutputDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'dead-domain-preview-output-'))

  WritePreviewArtifacts(OutputDirectory, '', '## Dead domain cleanup\n')

  expect(Fs.readdirSync(OutputDirectory).sort()).toEqual([DiffFileName, ReportFileName].sort())
  expect(Fs.readFileSync(Path.join(OutputDirectory, DiffFileName), 'utf-8')).toBe('')
  expect(Fs.readFileSync(Path.join(OutputDirectory, ReportFileName), 'utf-8')).toBe('## Dead domain cleanup\n')
})
