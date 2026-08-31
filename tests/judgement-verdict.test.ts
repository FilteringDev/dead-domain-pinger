import { expect, test } from 'vitest'
import type { GlobalpingMeasurement, GlobalpingProbeResult } from '../sources/globalping.ts'
import { ResolveJudgementPreferences } from '../sources/judgement-policy.ts'
import { EvaluateMeasurement } from '../sources/verdict.ts'

function Measurement(...Results: Partial<GlobalpingProbeResult>[]): GlobalpingMeasurement {
  return {
    status: 'finished',
    results: Results.map(Result => ({ result: { status: 'finished', ...Result } as GlobalpingProbeResult }))
  }
}

test('the same measurement can produce different origin judgements', () => {
  const Preferences = ResolveJudgementPreferences({
    networkPattern: {
      http: [{
        id: 'network-404-majority',
        when: { signal: 'statusCode', values: [404], minimumMatches: 2, minimumRatio: 0.66 },
        verdict: 'dead'
      }]
    },
    domainList: {
      http: [{
        id: 'list-404-present',
        when: { signal: 'statusCode', values: [404] },
        verdict: 'alive'
      }]
    }
  })
  const Result = EvaluateMeasurement('example.com', Measurement(
    { statusCode: 404, resolvedAddress: '1.1.1.1' },
    { statusCode: 404, resolvedAddress: '2.2.2.2' },
    { statusCode: 200, resolvedAddress: '3.3.3.3' }
  ), ['networkPattern', 'domainList'], Preferences)

  expect(Result.Verdict).toBe('Dead')
  expect(Result.Judgements.networkPattern).toMatchObject({
    Verdict: 'Dead',
    RuleId: 'network-404-majority',
    Stage: 'Http'
  })
  expect(Result.Judgements.domainList).toMatchObject({
    Verdict: 'Alive',
    RuleId: 'list-404-present',
    Stage: 'Http'
  })
})

test('continue advances from HTTP to Boolean body heuristics', () => {
  const Preferences = ResolveJudgementPreferences({
    matchers: {
      lifecycle: { type: 'regex', pattern: 'domain\\s+(?:expired|for sale)', flags: 'iu' }
    },
    default: {
      http: [{
        id: 'inspect-success-body',
        when: { signal: 'statusCode', values: ['2xx'] },
        verdict: 'continue'
      }],
      body: [{
        id: 'custom-parking-body',
        when: {
          all: [
            { signal: 'bodyPresent' },
            {
              any: [
                { signal: 'parkingProvider', providers: ['godaddy'] },
                { signal: 'bodyMatcher', matcher: 'lifecycle' }
              ]
            }
          ]
        },
        verdict: 'dead'
      }]
    }
  })
  const Result = EvaluateMeasurement('example.com', Measurement({
    statusCode: 200,
    resolvedAddress: '1.2.3.4',
    rawBody: '<html>This domain expired</html>'
  }), ['domainList'], Preferences)

  expect(Result.Verdict).toBe('Dead')
  expect(Result.Judgements.domainList).toMatchObject({
    Verdict: 'Dead',
    RuleId: 'custom-parking-body',
    Stage: 'Body'
  })
})

test('an empty effective policy falls through to unknown', () => {
  const Preferences = ResolveJudgementPreferences({
    default: { dns: [], http: [], body: [] }
  })
  const Result = EvaluateMeasurement('example.com', Measurement({
    statusCode: 200,
    resolvedAddress: '1.2.3.4'
  }), ['networkPattern'], Preferences)

  expect(Result.Verdict).toBe('Unknown')
  expect(Result.Judgements.networkPattern).toMatchObject({
    Verdict: 'Unknown',
    RuleId: null,
    Stage: null
  })
})

test('ratios use all returned probes as the denominator', () => {
  const Preferences = ResolveJudgementPreferences({
    default: {
      http: [{
        id: 'strict-majority',
        when: { signal: 'statusCode', values: [404], minimumMatches: 2, minimumRatio: 0.75 },
        verdict: 'dead'
      }]
    }
  })
  const Result = EvaluateMeasurement('example.com', Measurement(
    { statusCode: 404, resolvedAddress: '1.1.1.1' },
    { statusCode: 404, resolvedAddress: '2.2.2.2' },
    { statusCode: 200, resolvedAddress: '3.3.3.3' }
  ), ['networkPattern'], Preferences)

  expect(Result.Verdict).toBe('Unknown')
})
