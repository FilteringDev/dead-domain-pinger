import { expect, test } from 'vitest'
import { RewriteFilterContent, RewriteRule } from '../sources/rewrite-filters.ts'
import { CollectDomainOccurrencesFromContent } from '../sources/collect-domains.ts'

const DeadDomains = new Set(['example.com', 'example.org'])

test('RewriteRule keeps a cosmetic rule that still has live domains', () => {
  const Result = RewriteRule('example.org,live.com##.ads', new Set(['example.org']))

  expect(Result.Text).toBe('live.com##.ads')
  expect(Result.RemovedDomains).toEqual(['example.org'])
})

test('RewriteRule drops a cosmetic rule that loses every domain', () => {
  const Result = RewriteRule('example.com,example.org##.ads', DeadDomains)

  expect(Result.Text).toBe(null)
  expect(Result.RemovedDomains).toEqual(['example.com', 'example.org'])
})

test('RewriteRule drops a network rule whose $domain becomes empty', () => {
  const Result = RewriteRule('||powerads.org^$domain=example.com|example.org', DeadDomains)

  expect(Result.Text).toBe(null)
})

test('RewriteRule shrinks a network rule that keeps at least one domain', () => {
  const Result = RewriteRule('||powerads.org^$domain=example.com|alive.com', DeadDomains)

  expect(Result.Text).toBe('||powerads.org^$domain=alive.com')
})

test('RewriteRule drops a network rule whose pattern host is dead', () => {
  const Result = RewriteRule('||example.com^', DeadDomains)

  expect(Result.Text).toBe(null)
  expect(Result.RemovedDomains).toEqual(['example.com'])
})

test('RewriteRule drops a path-specific network rule whose pattern host is dead', () => {
  const Result = RewriteRule('||exmaple.com/mypath', new Set(['exmaple.com']))

  expect(Result.Text).toBe(null)
  expect(Result.RemovedDomains).toEqual(['exmaple.com'])
})

test('RewriteRule leaves a network pattern with an unknown suffix untouched', () => {
  const Result = RewriteRule('||stats.tira.', new Set(['stats.tira']))

  expect(Result.Text).toBe('||stats.tira.')
  expect(Result.RemovedDomains).toEqual([])
})

test('RewriteRule keeps negated domains and removes only dead permitted ones', () => {
  const Result = RewriteRule('example.com,live.com,~sub.live.com##.ads', DeadDomains)

  expect(Result.Text).toBe('live.com,~sub.live.com##.ads')
})

test('RewriteRule drops a rule that keeps only negated domains', () => {
  const Result = RewriteRule('example.com,~sub.example.com##.ads', DeadDomains)

  expect(Result.Text).toBe(null)
})

test('RewriteRule handles scriptlet and HTML filtering rules', () => {
  expect(RewriteRule('example.com,live.com#%#//scriptlet(\'abort-on-property-read\', \'foo\')', DeadDomains).Text).toBe('live.com#%#//scriptlet(\'abort-on-property-read\', \'foo\')')
  expect(RewriteRule('example.com$$script[tag-content="ads"]', DeadDomains).Text).toBe(null)
})

test('RewriteFilterContent removes lines and preserves everything else', () => {
  const Content = [
    '! Title: test',
    'example.com,live.com##.ads',
    'example.com,example.org##.banner',
    '||tracker.example.net^$third-party',
    ''
  ].join('\n')

  const Result = RewriteFilterContent('test.txt', Content, DeadDomains)

  expect(Result.Changed).toBeTruthy()
  expect(Result.Content).toBe([
    '! Title: test',
    'live.com##.ads',
    '||tracker.example.net^$third-party',
    ''
  ].join('\n'))
  expect(Result.ModifiedRules.length).toBe(1)
  expect(Result.RemovedRules.length).toBe(1)
})

test('RewriteFilterContent is a no-op when no dead domain is present', () => {
  const Content = 'live.com##.ads\n'

  expect(RewriteFilterContent('test.txt', Content, DeadDomains).Changed).toBe(false)
})

test('CollectDomainOccurrencesFromContent reports line numbers and skips non-domains', () => {
  const Content = [
    '! comment',
    'example.com##.ads',
    '||ads.example.net^$domain=shop.example.org|~sub.shop.example.org',
    '/regexp/##.ads',
    '*##.ads'
  ].join('\n')

  expect(CollectDomainOccurrencesFromContent('test.txt', Content)).toEqual([
    { Domain: 'example.com', FilePath: 'test.txt', LineNumber: 2 },
    { Domain: 'ads.example.net', FilePath: 'test.txt', LineNumber: 3 },
    { Domain: 'shop.example.org', FilePath: 'test.txt', LineNumber: 3 }
  ])
})
