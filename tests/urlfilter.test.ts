import { expect, test } from 'vitest'
import { BuildCheckDomainsPayload, FindUnusedDomains, UrlFilterCheckDomainsUrl } from '../sources/urlfilter.ts'

test('URL Filter payload uses filter none and normalizes IDN and FQDN domains', () => {
  expect(BuildCheckDomainsPayload(['example.com.', 'münich.example'])).toBe(
    'filter=none&domain=example.com&domain=xn--mnich-kva.example'
  )
})

test('URL Filter retains only domains whose registered domain was unused in the last 24 hours', async () => {
  let RequestUrl = ''
  let RequestPayload = ''

  const Result = await FindUnusedDomains({
    Domains: ['unused.example', 'active.example', 'missing.example'],
    Request: (Url, Options) => {
      RequestUrl = Url.toString()
      RequestPayload = Options.Payload
      return Promise.resolve({
        StatusCode: 200,
        Body: {
          'unused.example': { info: { registered_domain_used_last_24_hours: false } },
          'active.example': { info: { registered_domain_used_last_24_hours: true } }
        }
      })
    }
  })

  expect(RequestUrl).toBe(UrlFilterCheckDomainsUrl)
  expect(RequestPayload).toBe('filter=none&domain=unused.example&domain=active.example&domain=missing.example')
  expect(Result).toEqual(['unused.example'])
})

test('URL Filter retries a rate-limited request that supplies Retry-After', async () => {
  let Requests = 0

  const Result = await FindUnusedDomains({
    Domains: ['unused.example'],
    Request: () => {
      Requests += 1
      return Promise.resolve(Requests === 1
        ? { StatusCode: 429, Headers: { 'retry-after': '0' }, Body: {} }
        : { StatusCode: 200, Body: { 'unused.example': { info: { registered_domain_used_last_24_hours: false } } } })
    }
  })

  expect(Requests).toBe(2)
  expect(Result).toEqual(['unused.example'])
})

test('URL Filter rejects a rate-limited response without Retry-After', async () => {
  await expect(FindUnusedDomains({
    Domains: ['unused.example'],
    Request: () => Promise.resolve({ StatusCode: 429, Body: {} })
  })).rejects.toThrow('URL Filter check failed with HTTP 429')
})