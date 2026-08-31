import { expect, test } from 'vitest'
import { GetRuleDomains, NormalizeDomain, ParseRule } from '../sources/rule-domains.ts'

function DomainsOf(RawRule: string): string[] {
  const Rule = ParseRule(RawRule)

  return Rule ? GetRuleDomains(Rule) : []
}

test('NormalizeDomain normalizes registrable ICANN hostnames', () => {
  expect(NormalizeDomain(' EXAMPLE.COM. ')).toBe('example.com')
  expect(NormalizeDomain('sub.example.co.uk')).toBe('sub.example.co.uk')
  expect(NormalizeDomain('bücher.de')).toBe('bücher.de')
})

test('NormalizeDomain rejects unsupported and non-ICANN names', () => {
  for (const Domain of [
    'stats.tira.',
    'example.test',
    'co.uk',
    'localhost',
    '127.0.0.1',
    '[::1]',
    '*.example.com',
    'example.com/path'
  ]) {
    expect(NormalizeDomain(Domain)).toBe(null)
  }
})

test('GetRuleDomains extracts domain-anchored network pattern hosts', () => {
  expect(DomainsOf('||exmaple.com/mypath')).toEqual(['exmaple.com'])
  expect(DomainsOf('||sub.example.co.uk^$third-party')).toEqual(['sub.example.co.uk'])
  expect(DomainsOf('@@||example.com.^$domain=scope.org')).toEqual(['example.com', 'scope.org'])
  expect(DomainsOf('||example.com:8080/path')).toEqual(['example.com'])
})

test('GetRuleDomains deduplicates pattern and modifier domains', () => {
  expect(DomainsOf('||example.com^$domain=example.com')).toEqual(['example.com'])
})

test('GetRuleDomains skips unsupported network patterns', () => {
  for (const Rule of [
    '||stats.tira.',
    '||*.example.com^',
    '||co.uk^',
    '|https://example.com/path|',
    'example.com/path',
    '/example\\.com/'
  ]) {
    expect(DomainsOf(Rule)).toEqual([])
  }
})
