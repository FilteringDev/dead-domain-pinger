import test from 'node:test'
import assert from 'node:assert/strict'
import { ProbeDomainsWithWorkers } from '../sources/probe-pool.ts'
import type { DomainCandidate, DomainProbeResult } from '../sources/types.ts'

function Candidate(Domain: string): DomainCandidate {
  return {
    Domain,
    LatestModifiedAt: 0,
    LastCheckedAt: 0,
    ModifiedAtOverride: 0,
    SortKey: 0,
    Occurrences: []
  }
}

function AliveResult(Domain: string): DomainProbeResult {
  return {
    Domain,
    Verdict: 'Alive',
    Reason: 'ok',
    Warnings: [],
    SameDomainRedirects: [],
    ModifiedAtOverride: null
  }
}

test('ProbeDomainsWithWorkers preserves selected candidate order', async () => {
  const Result = await ProbeDomainsWithWorkers({
    Candidates: [Candidate('b.example'), Candidate('a.example')],
    CheckedAt: 1000,
    WorkerCount: 2,
    RunWorker: Data => Promise.resolve({ Type: 'Result', Result: AliveResult(Data.Domain) })
  })

  assert.deepEqual(Result.ProbeResults.map(ProbeResult => ProbeResult.Domain), ['b.example', 'a.example'])
  assert.equal(Result.RateLimited, false)
})

test('ProbeDomainsWithWorkers stops scheduling after a rate limit', async () => {
  const StartedDomains: string[] = []
  const Result = await ProbeDomainsWithWorkers({
    Candidates: [Candidate('a.example'), Candidate('b.example')],
    CheckedAt: 1000,
    WorkerCount: 1,
    RunWorker: Data => {
      StartedDomains.push(Data.Domain)
      return Promise.resolve({ Type: 'RateLimited', Message: 'limited' })
    }
  })

  assert.deepEqual(StartedDomains, ['a.example'])
  assert.deepEqual(Result.ProbeResults, [])
  assert.equal(Result.RateLimited, true)
  assert.equal(Result.RateLimitMessage, 'limited')
})

test('ProbeDomainsWithWorkers records worker failures as unknown probe results', async () => {
  const Result = await ProbeDomainsWithWorkers({
    Candidates: [Candidate('failed.example')],
    CheckedAt: 1000,
    WorkerCount: 1,
    RunWorker: () => Promise.reject(new Error('worker failed'))
  })

  assert.equal(Result.ProbeResults[0].Domain, 'failed.example')
  assert.equal(Result.ProbeResults[0].Verdict, 'Unknown')
  assert.equal(Result.ProbeResults[0].Reason, 'worker failed')
  assert.equal(Result.ProbeFailedDomains.has('failed.example'), true)
})