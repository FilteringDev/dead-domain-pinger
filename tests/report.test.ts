import { expect, test } from 'vitest'
import { BuildReportMarkdown } from '../sources/report.ts'

test('report includes per-origin rule ids and removal triggers', () => {
  const Report = BuildReportMarkdown({
    DryRun: true,
    SelectedCount: 1,
    RateLimited: false,
    ChangedFiles: ['filters.txt'],
    ModifiedRules: [],
    RemovedRules: [{
      FilePath: 'filters.txt',
      LineNumber: 2,
      Before: 'example.com##.ad',
      After: null,
      RemovedDomains: ['example.com'],
      Triggers: [{ Domain: 'example.com', Origin: 'domainList' }]
    }],
    RunUrl: null,
    ProbeResults: [{
      Domain: 'example.com',
      Target: 'example.com',
      Protocol: 'HTTPS',
      Verdict: 'Dead',
      Reason: 'Judgement rule custom-dead matched in the Body stage',
      Warnings: [],
      SameDomainRedirects: [],
      ModifiedAtOverride: null,
      NextProbe: null,
      Provisional: false,
      Judgements: {
        networkPattern: {
          Verdict: 'Alive',
          Reason: 'kept',
          Stage: 'Http',
          RuleId: 'keep-pattern'
        },
        domainList: {
          Verdict: 'Dead',
          Reason: 'custom body matched',
          Stage: 'Body',
          RuleId: 'custom-dead'
        }
      }
    }]
  })

  expect(Report).toContain('`example.com` [domainList] [custom-dead]')
  expect(Report).toContain('triggered by `example.com` [domainList]')
  expect(Report).toContain('`example.com` [networkPattern] — Alive [keep-pattern]')
})
