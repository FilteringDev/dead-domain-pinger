import { expect, test } from 'vitest'
import { DetermineNextProbe, type ProbeTransitionInput } from '../sources/probe-transitions.ts'
import { ProvisionalJudgements } from '../sources/probe-worker.ts'

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

test('queued follow-ups postpone every dead origin judgement', () => {
  const Judgements = ProvisionalJudgements({
    networkPattern: {
      Verdict: 'Dead',
      Reason: 'DNS failed',
      Stage: 'Dns',
      RuleId: 'dns-dead'
    },
    domainList: {
      Verdict: 'Alive',
      Reason: 'kept',
      Stage: 'Dns',
      RuleId: 'dns-alive'
    }
  }, ['networkPattern', 'domainList'], 'example.com')

  expect(Judgements.networkPattern).toMatchObject({
    Verdict: 'Unknown',
    Reason: 'Deletion postponed until queued follow-up probe of example.com completes'
  })
  expect(Judgements.domainList?.Verdict).toBe('Alive')
})
