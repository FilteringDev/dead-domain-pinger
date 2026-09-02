import { expect, test } from 'vitest'
import { VerifyParkedDomains } from '../sources/obscura.ts'
import type { ProbeWorkItem } from '../sources/types.ts'

const Work: ProbeWorkItem = {
  SourceDomain: 'ads.example.com', Target: 'ads.example.com', Protocol: 'HTTPS', PriorityKind: null, Origins: ['networkPattern']
}

test('Obscura uses stealth scraping and turns a parking redirect into a direct dead verdict', async () => {
  const Calls: { Arguments: string[], Input: string }[] = []
  const Results = await VerifyParkedDomains({
    WorkItems: [Work], BinaryPath: '/tmp/obscura', Concurrency: 12, TimeoutSeconds: 15,
    Run: Options => {
      Calls.push(Options)
      return Promise.resolve({
        Stdout: JSON.stringify({ results: [{ url: 'https://ads.example.com/', eval: 'https://sub.forsale.godaddy.com/listing' }] }), Stderr: ''
      })
    }
  })

  expect(Calls).toEqual([{
    BinaryPath: '/tmp/obscura',
    Arguments: ['--stealth', 'scrape', '-', '--concurrency', '12', '--timeout', '15', '--quiet', '--format', 'json', '--eval', 'document.location.href'],
    Input: 'https://ads.example.com/\n'
  }])
  expect(Results).toHaveLength(1)
  expect(Results[0].Judgements.networkPattern?.RuleId).toBe('obscura-parking-redirect')
})

test('Obscura retries HTTP only when HTTPS navigation fails', async () => {
  const Inputs: string[] = []
  const Results = await VerifyParkedDomains({
    WorkItems: [Work], BinaryPath: '/tmp/obscura', Concurrency: 1, TimeoutSeconds: 15,
    Run: Options => {
      Inputs.push(Options.Input)
      return Promise.resolve(Inputs.length === 1
        ? { Stdout: JSON.stringify({ results: [{ url: 'https://ads.example.com/', error: 'TLS failed' }] }), Stderr: '' }
        : { Stdout: JSON.stringify({ results: [{ url: 'http://ads.example.com/', eval: 'https://forsale.godaddy.com/listing' }] }), Stderr: '' })
    }
  })

  expect(Inputs).toEqual(['https://ads.example.com/\n', 'http://ads.example.com/\n'])
  expect(Results).toHaveLength(1)
})

test('Obscura failures and non-parking destinations remain inconclusive', async () => {
  await expect(VerifyParkedDomains({
    WorkItems: [Work], BinaryPath: '/tmp/obscura', Concurrency: 1, TimeoutSeconds: 15,
    Run: () => Promise.resolve({ Stdout: JSON.stringify({ results: [{ eval: 'https://www.example.com/' }] }), Stderr: '' })
  })).resolves.toEqual([])
})