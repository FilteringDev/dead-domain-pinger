import test from 'node:test'
import assert from 'node:assert/strict'
import * as Os from 'node:os'
import { GetDefaultWorkerCount, ProbeDomainsWithWorkers } from '../sources/probe-pool.ts'
import type { DomainProbeResult, ProbeWorkItem } from '../sources/types.ts'

function WorkItem(Domain: string): ProbeWorkItem {
  return {
    SourceDomain: Domain,
    Target: Domain,
    Protocol: 'HTTPS',
    PriorityKind: null
  }
}

function AliveResult(Domain: string): DomainProbeResult {
  return {
    Domain,
    Target: Domain,
    Protocol: 'HTTPS',
    Verdict: 'Alive',
    Reason: 'ok',
    Warnings: [],
    SameDomainRedirects: [],
    ModifiedAtOverride: null,
    NextProbe: null
  }
}

test('GetDefaultWorkerCount uses the Node.js CPU count', () => {
  assert.equal(GetDefaultWorkerCount(), Math.max(1, Os.cpus().length))
})

test('ProbeDomainsWithWorkers preserves selected candidate order', async () => {
  const Result = await ProbeDomainsWithWorkers({
    WorkItems: [WorkItem('b.example'), WorkItem('a.example')],
    ApiToken: 'token',
    Locations: [{ country: 'KR' }],
    Limit: 1,
    CheckedAt: 1000,
    WorkerCount: 2,
    RunWorker: Data => Promise.resolve({ Type: 'Result', Result: AliveResult(Data.SourceDomain) })
  })

  assert.deepEqual(Result.ProbeResults.map(ProbeResult => ProbeResult.Domain), ['b.example', 'a.example'])
  assert.equal(Result.RateLimited, false)
})

test('ProbeDomainsWithWorkers stops scheduling after a rate limit', async () => {
  const StartedDomains: string[] = []
  const Result = await ProbeDomainsWithWorkers({
    WorkItems: [WorkItem('a.example'), WorkItem('b.example')],
    ApiToken: 'token',
    Locations: [{ country: 'KR' }],
    Limit: 1,
    CheckedAt: 1000,
    WorkerCount: 1,
    RunWorker: Data => {
      StartedDomains.push(Data.SourceDomain)
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
    WorkItems: [WorkItem('failed.example')],
    ApiToken: 'token',
    Locations: [{ country: 'KR' }],
    Limit: 1,
    CheckedAt: 1000,
    WorkerCount: 1,
    RunWorker: () => Promise.reject(new Error('worker failed'))
  })

  assert.equal(Result.ProbeResults[0].Domain, 'failed.example')
  assert.equal(Result.ProbeResults[0].Verdict, 'Unknown')
  assert.equal(Result.ProbeResults[0].Reason, 'worker failed')
  assert.equal(Result.ProbeFailedDomains.has('failed.example'), true)
})