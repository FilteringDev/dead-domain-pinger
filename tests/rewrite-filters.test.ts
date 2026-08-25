import test from 'node:test'
import assert from 'node:assert/strict'
import { RewriteFilterContent, RewriteRule } from '../sources/rewrite-filters.ts'
import { CollectDomainOccurrencesFromContent } from '../sources/collect-domains.ts'

const DeadDomains = new Set(['example.com', 'example.org'])

test('RewriteRule keeps a cosmetic rule that still has live domains', () => {
  const Result = RewriteRule('example.org,live.com##.ads', new Set(['example.org']))

  assert.equal(Result.Text, 'live.com##.ads')
  assert.deepEqual(Result.RemovedDomains, ['example.org'])
})

test('RewriteRule drops a cosmetic rule that loses every domain', () => {
  const Result = RewriteRule('example.com,example.org##.ads', DeadDomains)

  assert.equal(Result.Text, null)
  assert.deepEqual(Result.RemovedDomains, ['example.com', 'example.org'])
})

test('RewriteRule drops a network rule whose $domain becomes empty', () => {
  const Result = RewriteRule('||powerads.org^$domain=example.com|example.org', DeadDomains)

  assert.equal(Result.Text, null)
})

test('RewriteRule shrinks a network rule that keeps at least one domain', () => {
  const Result = RewriteRule('||powerads.org^$domain=example.com|alive.com', DeadDomains)

  assert.equal(Result.Text, '||powerads.org^$domain=alive.com')
})

test('RewriteRule leaves the network pattern host untouched', () => {
  const Result = RewriteRule('||example.com^', DeadDomains)

  assert.equal(Result.Text, '||example.com^')
  assert.deepEqual(Result.RemovedDomains, [])
})

test('RewriteRule keeps negated domains and removes only dead permitted ones', () => {
  const Result = RewriteRule('example.com,live.com,~sub.live.com##.ads', DeadDomains)

  assert.equal(Result.Text, 'live.com,~sub.live.com##.ads')
})

test('RewriteRule drops a rule that keeps only negated domains', () => {
  const Result = RewriteRule('example.com,~sub.example.com##.ads', DeadDomains)

  assert.equal(Result.Text, null)
})

test('RewriteRule handles scriptlet and HTML filtering rules', () => {
  assert.equal(
    RewriteRule('example.com,live.com#%#//scriptlet(\'abort-on-property-read\', \'foo\')', DeadDomains).Text,
    'live.com#%#//scriptlet(\'abort-on-property-read\', \'foo\')'
  )
  assert.equal(RewriteRule('example.com$$script[tag-content="ads"]', DeadDomains).Text, null)
})

test('RewriteFilterContent removes lines and preserves everything else', () => {
  const Content = [
    '! Title: test',
    'example.com,live.com##.ads',
    'example.com,example.org##.banner',
    '||tracker.example^$third-party',
    ''
  ].join('\n')

  const Result = RewriteFilterContent('test.txt', Content, DeadDomains)

  assert.ok(Result.Changed)
  assert.equal(Result.Content, [
    '! Title: test',
    'live.com##.ads',
    '||tracker.example^$third-party',
    ''
  ].join('\n'))
  assert.equal(Result.ModifiedRules.length, 1)
  assert.equal(Result.RemovedRules.length, 1)
})

test('RewriteFilterContent is a no-op when no dead domain is present', () => {
  const Content = 'live.com##.ads\n'

  assert.equal(RewriteFilterContent('test.txt', Content, DeadDomains).Changed, false)
})

test('CollectDomainOccurrencesFromContent reports line numbers and skips non-domains', () => {
  const Content = [
    '! comment',
    'example.com##.ads',
    '||ads.example^$domain=shop.example|~sub.shop.example',
    '/regexp/##.ads',
    '*##.ads'
  ].join('\n')

  assert.deepEqual(CollectDomainOccurrencesFromContent('test.txt', Content), [
    { Domain: 'example.com', FilePath: 'test.txt', LineNumber: 2 },
    { Domain: 'shop.example', FilePath: 'test.txt', LineNumber: 3 }
  ])
})
