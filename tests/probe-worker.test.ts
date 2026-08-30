import { expect, test } from 'vitest'
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
  expect(DetermineNextProbe(WorkerData(), 'Tls')).toEqual({ Target: 'example.com', Kind: 'RetryOriginalHttp' })
})

test('DNS failure queues HTTP only for a registrable-domain root', () => {
  expect(DetermineNextProbe(WorkerData(), 'Dns')).toEqual({ Target: 'example.com', Kind: 'RetryOriginalHttp' })
  expect(DetermineNextProbe(WorkerData({ SourceDomain: 'cdn.example.com' }), 'Dns')).toBe(null)
})

test('failed root HTTP retry queues www HTTP for the next run', () => {
  expect(DetermineNextProbe(WorkerData({ Protocol: 'HTTP', PriorityKind: 'RetryOriginalHttp' }), 'Dns')).toEqual({
    Target: 'www.example.com',
    Kind: 'TryWwwHttp'
  })
})