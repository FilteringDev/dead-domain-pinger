import { expect, test } from 'vitest'
import { ResolveJudgementPreferences } from '../sources/judgement-policy.ts'

test('policy layers replace only the configured stage', () => {
  const Preferences = ResolveJudgementPreferences({
    default: {
      http: [{
        id: 'shared-http',
        when: { signal: 'statusCode', values: [404] },
        verdict: 'dead'
      }]
    },
    domainList: { http: [] }
  })

  expect(Preferences.Policies.networkPattern.Http.map(Rule => Rule.Id)).toEqual(['shared-http'])
  expect(Preferences.Policies.domainList.Http).toEqual([])
  expect(Preferences.Policies.networkPattern.Dns.map(Rule => Rule.Id)).toEqual(['default-dns-failure'])
  expect(Preferences.Policies.domainList.Dns.map(Rule => Rule.Id)).toEqual(['default-dns-failure'])
})

test('policy fingerprint is canonical and changes with effective behavior', () => {
  const Left = ResolveJudgementPreferences({
    matchers: {
      beta: { type: 'literal', value: 'b' },
      alpha: { type: 'literal', value: 'a' }
    }
  })
  const Right = ResolveJudgementPreferences({
    matchers: {
      alpha: { value: 'a', type: 'literal' },
      beta: { value: 'b', type: 'literal' }
    }
  })
  const Changed = ResolveJudgementPreferences({
    matchers: {
      alpha: { type: 'literal', value: 'changed' },
      beta: { type: 'literal', value: 'b' }
    }
  })

  expect(Left.Fingerprint).toBe(Right.Fingerprint)
  expect(Left.Fingerprint).not.toBe(Changed.Fingerprint)
})

test('policy rejects duplicate rule ids and unknown matcher references', () => {
  expect(() => ResolveJudgementPreferences({
    default: {
      dns: [
        { id: 'duplicate', when: { signal: 'dnsFailure' }, verdict: 'dead' },
        { id: 'duplicate', when: { signal: 'dnsResolved' }, verdict: 'alive' }
      ]
    }
  })).toThrow('Duplicate judgement rule id')

  expect(() => ResolveJudgementPreferences({
    default: {
      body: [{
        id: 'missing-matcher',
        when: { signal: 'bodyMatcher', matcher: 'missing' },
        verdict: 'dead'
      }]
    }
  })).toThrow('Unknown body matcher')

  expect(() => ResolveJudgementPreferences({
    default: {
      dns: [{
        id: 'cross-stage',
        when: { signal: 'dnsFailure' },
        verdict: 'dead'
      }],
      http: [{
        id: 'cross-stage',
        when: { signal: 'timeout' },
        verdict: 'alive'
      }]
    }
  })).toThrow('Duplicate judgement rule id in effective policy')
})

test('policy rejects signals in the wrong processing stage', () => {
  expect(() => ResolveJudgementPreferences({
    default: {
      dns: [{
        id: 'wrong-stage',
        when: { signal: 'statusCode', values: [404] },
        verdict: 'dead'
      }]
    }
  })).toThrow('statusCode is not a valid signal in the Dns stage')
})

test('policy rejects invalid native regular expressions', () => {
  expect(() => ResolveJudgementPreferences({
    matchers: {
      broken: { type: 'regex', pattern: '[', flags: 'iu' }
    }
  })).toThrow('Invalid body matcher broken')
})
