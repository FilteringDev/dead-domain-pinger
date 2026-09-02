import { expect, test } from 'vitest'
import { AssertWorkerArtifactCommits, AssertWorkerArtifactPaths, BuildMatrixEntries, MergeGitOrderCache, MergeWorkerArtifacts, WorkerArtifactSchema, WorkerArtifactVersion } from '../sources/stage-artifacts.ts'
import { CreateEmptyState, RecordVerdict } from '../sources/state.ts'
import type { WorkerArtifact } from '../sources/stage-artifacts.ts'

const HeadCommitSha = 'a'.repeat(40)

function Artifact(Overrides: Partial<WorkerArtifact> = {}): WorkerArtifact {
  return {
    Version: WorkerArtifactVersion,
    ScopeId: 'filters-1',
    CommitSha: HeadCommitSha,
    Candidates: [{
      Domain: 'old.example',
      LatestModifiedAt: 100,
      LastCheckedAt: 0,
      ModifiedAtOverride: 0,
      SortKey: 100,
      Occurrences: [{ Domain: 'old.example', FilePath: 'filters/a.txt', LineNumber: 1, Origin: 'domainList' }],
      Origins: ['domainList']
    }],
    GitOrderCache: [],
    ConsideredCount: 1,
    UrlFilterSelectedCount: 1,
    FallbackCount: 0,
    Warnings: [],
    ...Overrides
  }
}

test('BuildMatrixEntries removes nested scopes and creates stable entries', () => {
  expect(BuildMatrixEntries('/workspace', 'filters\nfilters/privacy\nlists')).toEqual([
    { Id: 'filters-1', Directory: 'filters' },
    { Id: 'lists-2', Directory: 'lists' }
  ])
})

test('worker artifacts reject unknown fields and incompatible versions', () => {
  expect(() => WorkerArtifactSchema.parse({ ...Artifact(), Version: 1 })).toThrow()
  expect(() => WorkerArtifactSchema.parse({ ...Artifact(), Unexpected: true })).toThrow()
})

test('worker artifacts require a full commit hash of the tree they indexed', () => {
  expect(() => WorkerArtifactSchema.parse({ ...Artifact(), CommitSha: 'abc1234' })).toThrow()
  const WithoutCommitSha: Record<string, unknown> = { ...Artifact() }
  delete WithoutCommitSha.CommitSha
  expect(() => WorkerArtifactSchema.parse(WithoutCommitSha)).toThrow()
})

test('postprocess rejects worker artifacts indexed at another commit', () => {
  const Stale = Artifact({ ScopeId: 'lists-2', CommitSha: 'b'.repeat(40) })
  expect(() => AssertWorkerArtifactCommits(HeadCommitSha, [Artifact(), Stale])).toThrow('lists-2=' + 'b'.repeat(40))
  expect(() => AssertWorkerArtifactCommits(HeadCommitSha, [Artifact(), Artifact({ ScopeId: 'lists-2' })])).not.toThrow()
})

test('worker artifacts cannot direct postprocess outside the workspace', () => {
  const ArtifactWithOutsidePath = Artifact({
    Candidates: [{
      ...Artifact().Candidates[0],
      Occurrences: [{ Domain: 'old.example', FilePath: '../outside.txt', LineNumber: 1, Origin: 'domainList' }]
    }]
  })
  expect(() => AssertWorkerArtifactPaths('/workspace', ArtifactWithOutsidePath)).toThrow('outside the workspace')
})

test('MergeWorkerArtifacts deduplicates occurrences and restores persisted ordering state', () => {
  const State = CreateEmptyState()
  RecordVerdict(State, 'old.example', 'Alive', 500, [])
  const Candidates = MergeWorkerArtifacts([
    Artifact(),
    Artifact({ ScopeId: 'lists-2', Candidates: [{
      ...Artifact().Candidates[0],
      Occurrences: [
        { Domain: 'old.example', FilePath: 'filters/a.txt', LineNumber: 1, Origin: 'domainList' },
        { Domain: 'old.example', FilePath: 'lists/b.txt', LineNumber: 2, Origin: 'networkPattern' }
      ],
      Origins: ['networkPattern', 'domainList']
    }] })
  ], State)

  expect(Candidates).toHaveLength(1)
  expect(Candidates[0]).toMatchObject({ LastCheckedAt: 500, SortKey: 500, Origins: ['networkPattern', 'domainList'] })
  expect(Candidates[0].Occurrences).toHaveLength(2)
})

test('MergeGitOrderCache removes duplicate entries', () => {
  const Entry = { FilePath: 'filters/a.txt', Revision: 'a'.repeat(40), LineNumber: 1, Domain: 'old.example', ModifiedAt: 100 }
  expect(MergeGitOrderCache([Artifact({ GitOrderCache: [Entry] }), Artifact({ ScopeId: 'lists-2', GitOrderCache: [Entry] })])).toEqual([Entry])
})