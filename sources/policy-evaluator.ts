import type {
  JudgementCondition,
  JudgementExpression,
  JudgementPolicy,
  JudgementRule,
  JudgementStage
} from './judgement-policy.ts'
import type { OriginJudgement } from './types.ts'

export type SignalEvaluator = (Condition: JudgementCondition) => boolean
export type RuleReasonBuilder = (Rule: JudgementRule, Stage: JudgementStage) => string

function ExpressionMatches(Expression: JudgementExpression, EvaluateSignal: SignalEvaluator): boolean {
  if (Expression.Type === 'Condition') {
    return EvaluateSignal(Expression.Condition)
  }

  if (Expression.Type === 'All') {
    return Expression.Expressions.every(Child => ExpressionMatches(Child, EvaluateSignal))
  }

  if (Expression.Type === 'Any') {
    return Expression.Expressions.some(Child => ExpressionMatches(Child, EvaluateSignal))
  }

  return !ExpressionMatches(Expression.Expression, EvaluateSignal)
}

function EvaluateStage(
  Stage: JudgementStage,
  Rules: JudgementRule[],
  EvaluateSignal: SignalEvaluator,
  BuildReason: RuleReasonBuilder
): OriginJudgement | null {
  for (const Rule of Rules) {
    if (!ExpressionMatches(Rule.When, EvaluateSignal)) {
      continue
    }

    if (Rule.Verdict === 'Continue') {
      return null
    }

    return {
      Verdict: Rule.Verdict,
      Reason: BuildReason(Rule, Stage),
      Stage,
      RuleId: Rule.Id
    }
  }

  return null
}

export function EvaluateJudgementPolicy(
  Policy: JudgementPolicy,
  EvaluateSignal: SignalEvaluator,
  BuildReason: RuleReasonBuilder
): OriginJudgement {
  for (const [Stage, Rules] of [
    ['Dns', Policy.Dns],
    ['Http', Policy.Http],
    ['Body', Policy.Body]
  ] as const) {
    const Judgement = EvaluateStage(Stage, Rules, EvaluateSignal, BuildReason)
    if (Judgement) {
      return Judgement
    }
  }

  return {
    Verdict: 'Unknown',
    Reason: 'No judgement policy rule produced a terminal verdict',
    Stage: null,
    RuleId: null
  }
}
