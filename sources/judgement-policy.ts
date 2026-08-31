import { createHash } from 'node:crypto'
import * as Zod from 'zod'
import type { DomainOrigin } from './types.ts'

export const JudgementPolicyVersion = 1

const MaximumExpressionDepth = 12
const MaximumExpressionNodes = 256
const MaximumMatcherCount = 100

const StageSignals: Record<JudgementStage, Set<JudgementSignal>> = {
  Dns: new Set([
    'dnsResolved',
    'dnsFailure'
  ]),
  Http: new Set([
    'tlsValidationFailure',
    'timeout',
    'redirect',
    'parkingRedirect',
    'foreignRedirect',
    'sameDomainRedirect',
    'statusCode',
    'probeFailure'
  ]),
  Body: new Set([
    'bodyPresent',
    'bodyTruncated',
    'parkingProvider',
    'bodyMatcher'
  ])
}

const MaximumPatternLength = 1024
const MaximumRulesPerStage = 100

export type JudgementStage = 'Dns' | 'Http' | 'Body'
export type JudgementRuleVerdict = 'Alive' | 'Dead' | 'Unknown' | 'Continue'
export type JudgementSignal =
  | 'dnsResolved'
  | 'dnsFailure'
  | 'tlsValidationFailure'
  | 'timeout'
  | 'redirect'
  | 'parkingRedirect'
  | 'foreignRedirect'
  | 'sameDomainRedirect'
  | 'statusCode'
  | 'probeFailure'
  | 'bodyPresent'
  | 'bodyTruncated'
  | 'parkingProvider'
  | 'bodyMatcher'

export type ParkingProvider = 'godaddy' | 'sedo' | 'bodis' | 'hugeDomains' | 'namecheap'
export type StatusCodeSelector = number | '1xx' | '2xx' | '3xx' | '4xx' | '5xx'

export type JudgementCondition = {
  Signal: JudgementSignal
  MinimumMatches: number
  MinimumRatio: number | null
  Values?: StatusCodeSelector[]
  Providers?: ParkingProvider[]
  Matcher?: string
}

export type JudgementExpression =
  | { Type: 'Condition', Condition: JudgementCondition }
  | { Type: 'All', Expressions: JudgementExpression[] }
  | { Type: 'Any', Expressions: JudgementExpression[] }
  | { Type: 'Not', Expression: JudgementExpression }

export type JudgementRule = {
  Id: string
  When: JudgementExpression
  Verdict: JudgementRuleVerdict
}

export type JudgementPolicy = {
  Dns: JudgementRule[]
  Http: JudgementRule[]
  Body: JudgementRule[]
}

export type BodyMatcher = {
  Kind: 'Literal'
  Value: string
  CaseSensitive: boolean
} | {
  Kind: 'Regex'
  Pattern: string
  Flags: string
}

export type ResolvedJudgementPreferences = {
  Policies: Record<DomainOrigin, JudgementPolicy>
  Matchers: Record<string, BodyMatcher>
  Fingerprint: string
}

/* oxlint-disable dead-domain-pinger/pascal-case -- These keys are the documented JSON contract. */
type JsonCondition = {
  signal: JudgementSignal
  minimumMatches?: number
  minimumRatio?: number
  values?: StatusCodeSelector[]
  providers?: ParkingProvider[]
  matcher?: string
}

type JsonExpression = JsonCondition | { all: JsonExpression[] } | { any: JsonExpression[] } | { not: JsonExpression }
/* oxlint-enable dead-domain-pinger/pascal-case */

const ThresholdFields = {
  minimumMatches: Zod.number().int().positive().max(500).optional(),
  minimumRatio: Zod.number().positive().max(1).optional()
}

const SimpleConditionSchema = (Signal: Exclude<JudgementSignal, 'statusCode' | 'parkingProvider' | 'bodyMatcher'>) => Zod.object({
  signal: Zod.literal(Signal),
  ...ThresholdFields
}).strict()

const ConditionSchema = Zod.discriminatedUnion('signal', [
  SimpleConditionSchema('dnsResolved'),
  SimpleConditionSchema('dnsFailure'),
  SimpleConditionSchema('tlsValidationFailure'),
  SimpleConditionSchema('timeout'),
  SimpleConditionSchema('redirect'),
  SimpleConditionSchema('parkingRedirect'),
  SimpleConditionSchema('foreignRedirect'),
  SimpleConditionSchema('sameDomainRedirect'),
  Zod.object({
    signal: Zod.literal('statusCode'),
    values: Zod.array(Zod.union([
      Zod.number().int().min(100).max(599),
      Zod.enum(['1xx', '2xx', '3xx', '4xx', '5xx'])
    ])).min(1),
    ...ThresholdFields
  }).strict(),
  SimpleConditionSchema('probeFailure'),
  SimpleConditionSchema('bodyPresent'),
  SimpleConditionSchema('bodyTruncated'),
  Zod.object({
    signal: Zod.literal('parkingProvider'),
    providers: Zod.array(Zod.enum(['godaddy', 'sedo', 'bodis', 'hugeDomains', 'namecheap'])).min(1).optional(),
    ...ThresholdFields
  }).strict(),
  Zod.object({
    signal: Zod.literal('bodyMatcher'),
    matcher: Zod.string().nonempty(),
    ...ThresholdFields
  }).strict()
])

const ExpressionSchema: Zod.ZodType<JsonExpression> = Zod.lazy(() => Zod.union([
  ConditionSchema,
  Zod.object({ all: Zod.array(ExpressionSchema).min(1) }).strict(),
  Zod.object({ any: Zod.array(ExpressionSchema).min(1) }).strict(),
  Zod.object({ not: ExpressionSchema }).strict()
]))

const RuleSchema = Zod.object({
  id: Zod.string().trim().nonempty(),
  when: ExpressionSchema,
  verdict: Zod.enum(['alive', 'dead', 'unknown', 'continue'])
}).strict()

const PolicyOverrideSchema = Zod.object({
  dns: Zod.array(RuleSchema).max(MaximumRulesPerStage).optional(),
  http: Zod.array(RuleSchema).max(MaximumRulesPerStage).optional(),
  body: Zod.array(RuleSchema).max(MaximumRulesPerStage).optional()
}).strict()

const MatcherSchema = Zod.discriminatedUnion('type', [
  Zod.object({
    type: Zod.literal('literal'),
    value: Zod.string().min(1).max(MaximumPatternLength),
    caseSensitive: Zod.boolean().default(false)
  }).strict(),
  Zod.object({
    type: Zod.literal('regex'),
    pattern: Zod.string().min(1).max(MaximumPatternLength),
    flags: Zod.string().regex(/^[imsu]*$/).default('iu')
  }).strict()
])

export const JudgementPreferencesSchema = Zod.object({
  matchers: Zod.record(Zod.string().nonempty(), MatcherSchema).refine(Value => Object.keys(Value).length <= MaximumMatcherCount, {
    message: 'No more than ' + MaximumMatcherCount + ' body matchers are allowed'
  }).default({}),
  default: PolicyOverrideSchema.optional(),
  networkPattern: PolicyOverrideSchema.optional(),
  domainList: PolicyOverrideSchema.optional()
}).strict()

export type JsonJudgementPreferences = Zod.infer<typeof JudgementPreferencesSchema>

function Condition(Signal: JudgementSignal, Options: Partial<Omit<JudgementCondition, 'Signal'>> = {}): JudgementExpression {
  return {
    Type: 'Condition',
    Condition: {
      Signal,
      MinimumMatches: Options.MinimumMatches ?? 1,
      MinimumRatio: Options.MinimumRatio ?? null,
      ...(Options.Values ? { Values: Options.Values } : {}),
      ...(Options.Providers ? { Providers: Options.Providers } : {}),
      ...(Options.Matcher ? { Matcher: Options.Matcher } : {})
    }
  }
}

const BuiltInPolicy: JudgementPolicy = {
  Dns: [{
    Id: 'default-dns-failure',
    When: Condition('dnsFailure', { MinimumRatio: 1 }),
    Verdict: 'Dead'
  }],
  Http: [
    {
      Id: 'default-tls-failure',
      When: Condition('tlsValidationFailure', { MinimumRatio: 1 }),
      Verdict: 'Dead'
    },
    {
      Id: 'default-parking-redirect',
      When: {
        Type: 'All',
        Expressions: [
          Condition('redirect', { MinimumRatio: 1 }),
          Condition('parkingRedirect')
        ]
      },
      Verdict: 'Dead'
    },
    {
      Id: 'default-foreign-redirect',
      When: {
        Type: 'All',
        Expressions: [
          Condition('redirect', { MinimumRatio: 1 }),
          Condition('foreignRedirect')
        ]
      },
      Verdict: 'Dead'
    },
    {
      Id: 'default-http-success',
      When: Condition('statusCode', { Values: ['2xx'] }),
      Verdict: 'Alive'
    },
    {
      Id: 'default-timeout',
      When: Condition('timeout'),
      Verdict: 'Alive'
    }
  ],
  Body: []
}

function TransformExpression(Expression: JsonExpression, Depth = 1, Count = { Value: 0 }): JudgementExpression {
  Count.Value += 1
  if (Depth > MaximumExpressionDepth || Count.Value > MaximumExpressionNodes) {
    throw new Error('Judgement expression exceeds configured complexity limits')
  }

  if ('signal' in Expression) {
    return Condition(Expression.signal, {
      MinimumMatches: Expression.minimumMatches,
      MinimumRatio: Expression.minimumRatio,
      Values: Expression.values,
      Providers: Expression.providers,
      Matcher: Expression.matcher
    })
  }

  if ('all' in Expression) {
    return { Type: 'All', Expressions: Expression.all.map(Child => TransformExpression(Child, Depth + 1, Count)) }
  }

  if ('any' in Expression) {
    return { Type: 'Any', Expressions: Expression.any.map(Child => TransformExpression(Child, Depth + 1, Count)) }
  }

  return { Type: 'Not', Expression: TransformExpression(Expression.not, Depth + 1, Count) }
}

function ValidateMatcherReferences(Expression: JudgementExpression, Matchers: Record<string, BodyMatcher>): void {
  if (Expression.Type === 'Condition') {
    if (Expression.Condition.Signal === 'bodyMatcher' && !Matchers[Expression.Condition.Matcher ?? '']) {
      throw new Error('Unknown body matcher: ' + (Expression.Condition.Matcher ?? ''))
    }
    return
  }

  if (Expression.Type === 'Not') {
    ValidateMatcherReferences(Expression.Expression, Matchers)
    return
  }

  for (const Child of Expression.Expressions) {
    ValidateMatcherReferences(Child, Matchers)
  }
}

function ValidateStageSignals(Expression: JudgementExpression, Stage: JudgementStage): void {
  if (Expression.Type === 'Condition') {
    if (!StageSignals[Stage].has(Expression.Condition.Signal)) {
      throw new Error(Expression.Condition.Signal + ' is not a valid signal in the ' + Stage + ' stage')
    }
    return
  }

  if (Expression.Type === 'Not') {
    ValidateStageSignals(Expression.Expression, Stage)
    return
  }

  for (const Child of Expression.Expressions) {
    ValidateStageSignals(Child, Stage)
  }
}

function TransformRules(
  Rules: Zod.infer<typeof RuleSchema>[],
  Matchers: Record<string, BodyMatcher>,
  Stage: JudgementStage
): JudgementRule[] {
  const SeenIds = new Set<string>()

  return Rules.map(Rule => {
    if (SeenIds.has(Rule.id)) {
      throw new Error('Duplicate judgement rule id: ' + Rule.id)
    }
    SeenIds.add(Rule.id)

    const When = TransformExpression(Rule.when)
    ValidateMatcherReferences(When, Matchers)
    ValidateStageSignals(When, Stage)

    return {
      Id: Rule.id,
      When,
      Verdict: Rule.verdict === 'alive'
        ? 'Alive'
        : Rule.verdict === 'dead'
          ? 'Dead'
          : Rule.verdict === 'unknown'
            ? 'Unknown'
            : 'Continue'
    }
  })
}

function TransformMatchers(Matchers: JsonJudgementPreferences['matchers']): Record<string, BodyMatcher> {
  return Object.fromEntries(Object.entries(Matchers).map(([Id, Matcher]): [string, BodyMatcher] => {
    if (Matcher.type === 'literal') {
      return [Id, { Kind: 'Literal', Value: Matcher.value, CaseSensitive: Matcher.caseSensitive }]
    }

    try {
      new RegExp(Matcher.pattern, Matcher.flags)
    } catch (ErrorValue) {
      const Detail = ErrorValue instanceof Error ? ErrorValue.message : String(ErrorValue)
      throw new Error('Invalid body matcher ' + Id + ': ' + Detail)
    }

    return [Id, { Kind: 'Regex', Pattern: Matcher.pattern, Flags: Matcher.flags }]
  }))
}

function ApplyOverride(
  Base: JudgementPolicy,
  Override: Zod.infer<typeof PolicyOverrideSchema> | undefined,
  Matchers: Record<string, BodyMatcher>
): JudgementPolicy {
  return {
    Dns: Override?.dns ? TransformRules(Override.dns, Matchers, 'Dns') : structuredClone(Base.Dns),
    Http: Override?.http ? TransformRules(Override.http, Matchers, 'Http') : structuredClone(Base.Http),
    Body: Override?.body ? TransformRules(Override.body, Matchers, 'Body') : structuredClone(Base.Body)
  }
}

function ValidatePolicyRuleIds(Policy: JudgementPolicy): void {
  const SeenIds = new Set<string>()

  for (const Rules of [Policy.Dns, Policy.Http, Policy.Body]) {
    for (const Rule of Rules) {
      if (SeenIds.has(Rule.Id)) {
        throw new Error('Duplicate judgement rule id in effective policy: ' + Rule.Id)
      }
      SeenIds.add(Rule.Id)
    }
  }
}

function Canonicalize(Value: unknown): unknown {
  if (Array.isArray(Value)) {
    return Value.map(Canonicalize)
  }

  if (Value !== null && typeof Value === 'object') {
    return Object.fromEntries(Object.entries(Value)
      .sort(([Left], [Right]) => Left < Right ? -1 : Left > Right ? 1 : 0)
      .map(([Key, Entry]) => [Key, Canonicalize(Entry)]))
  }

  return Value
}

export function ResolveJudgementPreferences(Input?: unknown): ResolvedJudgementPreferences {
  const Parsed = JudgementPreferencesSchema.parse(Input ?? {})
  const Matchers = TransformMatchers(Parsed.matchers)
  const Shared = ApplyOverride(BuiltInPolicy, Parsed.default, Matchers)
  const Policies = {
    networkPattern: ApplyOverride(Shared, Parsed.networkPattern, Matchers),
    domainList: ApplyOverride(Shared, Parsed.domainList, Matchers)
  }
  for (const Policy of Object.values(Policies)) {
    ValidatePolicyRuleIds(Policy)
  }

  const FingerprintPayload = Canonicalize({ Version: JudgementPolicyVersion, Policies, Matchers })
  const Fingerprint = createHash('sha256').update(JSON.stringify(FingerprintPayload)).digest('hex')

  return { Policies, Matchers, Fingerprint }
}

export const DefaultJudgementPreferences = ResolveJudgementPreferences()
