import type { DomainOrigin, DomainProbeResult, OriginJudgement, RuleChange } from './types.ts'

export const ReportFileName = 'dead-domain-report.md'
export const PullRequestBodyFileName = 'pull-request-body.md'

const Code = String.fromCharCode(96)

export type ReportInput = {
  DryRun: boolean
  SelectedCount: number
  ProbeResults: DomainProbeResult[]
  RateLimited: boolean
  ChangedFiles: string[]
  ModifiedRules: RuleChange[]
  RemovedRules: RuleChange[]
  RunUrl: string | null
}

type JudgementEntry = {
  Domain: string
  Origin: DomainOrigin
  Judgement: OriginJudgement
}

function GetWarningEntries(ProbeResults: DomainProbeResult[]): { Domain: string, Warning: string }[] {
  return ProbeResults.flatMap(Result => Result.Warnings.map(Warning => ({ Domain: Result.Domain, Warning })))
}

function GetJudgementEntries(ProbeResults: DomainProbeResult[]): JudgementEntry[] {
  return ProbeResults.flatMap(Result => {
    return (Object.entries(Result.Judgements) as [DomainOrigin, OriginJudgement][])
      .map(([Origin, Judgement]) => ({ Domain: Result.Domain, Origin, Judgement }))
  })
}

function FormatTriggers(Change: RuleChange): string {
  return Change.Triggers
    .map(Trigger => Code + Trigger.Domain + Code + ' [' + Trigger.Origin + ']')
    .join(', ')
}

function BuildBody(Input: ReportInput): string[] {
  const Judgements = GetJudgementEntries(Input.ProbeResults)
  const DeadJudgements = Judgements.filter(Entry => Entry.Judgement.Verdict === 'Dead')
  const DeadDomainCount = new Set(DeadJudgements.map(Entry => Entry.Domain)).size
  const RedirectResults = Input.ProbeResults.filter(Result => Result.ModifiedAtOverride !== null)
  const Warnings = GetWarningEntries(Input.ProbeResults)
  const FollowUps = Input.ProbeResults.filter(Result => Result.NextProbe !== null)
  const Lines: string[] = []

  Lines.push(
    '- Dry run: ' + Code + Input.DryRun + Code,
    '- Probed domains: ' + Input.ProbeResults.length + ' / ' + Input.SelectedCount + (Input.RateLimited ? ' (stopped early: rate limited)' : ''),
    '- Dead domains: ' + DeadDomainCount,
    '- Dead origin judgements: ' + DeadJudgements.length,
    '- Redirects detected (kept): ' + RedirectResults.length,
    '- HTTP follow-ups queued: ' + FollowUps.length,
    '- Warnings: ' + Warnings.length,
    '- Changed files: ' + Input.ChangedFiles.length,
    '- Modified rules: ' + Input.ModifiedRules.length,
    '- Removed rules: ' + Input.RemovedRules.length,
    ''
  )

  if (DeadJudgements.length > 0) {
    Lines.push('### Dead domain origins', '')
    Lines.push(...DeadJudgements.map(Entry => {
      const Rule = Entry.Judgement.RuleId ? ' [' + Entry.Judgement.RuleId + ']' : ''

      return '- ' + Code + Entry.Domain + Code + ' [' + Entry.Origin + ']' + Rule + ' — ' + Entry.Judgement.Reason
    }))
    Lines.push('')
  }

  if (Judgements.length > 0) {
    Lines.push('### Per-origin judgements', '')
    Lines.push(...Judgements.map(Entry => {
      const Rule = Entry.Judgement.RuleId ? ' [' + Entry.Judgement.RuleId + ']' : ''

      return '- ' + Code + Entry.Domain + Code + ' [' + Entry.Origin + '] — ' + Entry.Judgement.Verdict + Rule + ' — ' + Entry.Judgement.Reason
    }))
    Lines.push('')
  }

  if (RedirectResults.length > 0) {
    Lines.push(
      '### Redirect detected (kept)',
      '',
      'These domains redirect inside their own registrable domain. Nothing was removed; their',
      'last-modified date is overridden to the timestamp below so they are not re-probed daily.',
      ''
    )
    Lines.push(...RedirectResults.map(Result => {
      const OverriddenAt = new Date((Result.ModifiedAtOverride ?? 0) * 1000).toISOString()
      const Targets = Result.SameDomainRedirects.map(Target => Code + Target + Code).join(', ')

      return '- ' + Code + Result.Domain + Code + ' → ' + Targets + ' — last-modified date overridden to ' + OverriddenAt
    }))
    Lines.push('')
  }

  if (Warnings.length > 0) {
    Lines.push('### Warnings', '')
    Lines.push(...Warnings.map(Entry => '- ' + Code + Entry.Domain + Code + ' — ' + Entry.Warning))
    Lines.push('')
  }

  if (FollowUps.length > 0) {
    Lines.push('### HTTP follow-ups queued', '')
    Lines.push(...FollowUps.map(Result => {
      return '- ' + Code + Result.Domain + Code + ' -> ' + Code + Result.NextProbe?.Target + Code + ' (' + Result.NextProbe?.Kind + ') — deletion postponed'
    }))
    Lines.push('')
  }

  if (Input.RemovedRules.length > 0) {
    Lines.push('### Removed rules', '')
    Lines.push(...Input.RemovedRules.map(Change => {
      return '- ' + Code + Change.Before + Code + ' (' + Change.FilePath + ':' + Change.LineNumber + ') — triggered by ' + FormatTriggers(Change)
    }))
    Lines.push('')
  }

  if (Input.ModifiedRules.length > 0) {
    Lines.push('### Modified rules', '')
    Lines.push(...Input.ModifiedRules.map(Change => {
      return '- ' + Code + Change.Before + Code + ' → ' + Code + Change.After + Code + ' (' + Change.FilePath + ':' + Change.LineNumber + ') — triggered by ' + FormatTriggers(Change)
    }))
    Lines.push('')
  }

  if (Input.RunUrl) {
    Lines.push('Run: ' + Input.RunUrl, '')
  }

  return Lines
}

export function BuildReportMarkdown(Input: ReportInput): string {
  return ['## Dead domain cleanup', '', ...BuildBody(Input)].join('\n')
}

export function BuildPullRequestBody(Input: ReportInput): string {
  const Intro = [
    'Domains were probed using configured [Globalping](https://globalping.io) locations and',
    'evaluated with the repository judgement preferences for each AGTree domain origin.',
    'Ambiguous and provisional results do not remove filter occurrences.',
    ''
  ]

  return [...Intro, ...BuildBody(Input)].join('\n')
}
