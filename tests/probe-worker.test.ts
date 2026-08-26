import test from 'node:test'
import assert from 'node:assert/strict'
import { DetermineNextProbe, type ProbeTransitionInput } from '../sources/probe-transitions.ts'

function WorkerData(Overrides: Partial<ProbeTransitionInput> = {}): ProbeTransitionInput {
  return {
    SourceDomain: 'example.com',
    Protocol: 'HTTPS',
    PriorityKind: null,
    ...Overrides
  }
}

test('TLS failure on HTTPS queues HTTP for the source domain', () => {
  assert.deepEqual(DetermineNextProbe(WorkerData(), 'Tls'), { Target: 'example.com', Kind: 'RetryOriginalHttp' })
})

test('DNS failure queues HTTP only for a registrable-domain root', () => {
  assert.deepEqual(DetermineNextProbe(WorkerData(), 'Dns'), { Target: 'example.com', Kind: 'RetryOriginalHttp' })
  assert.equal(DetermineNextProbe(WorkerData({ SourceDomain: 'cdn.example.com' }), 'Dns'), null)
})

test('failed root HTTP retry queues www HTTP for the next run', () => {
  assert.deepEqual(DetermineNextProbe(WorkerData({ Protocol: 'HTTP', PriorityKind: 'RetryOriginalHttp' }), 'Dns'), {
    Target: 'www.example.com',
    Kind: 'TryWwwHttp'
  })
})