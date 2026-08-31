import * as AGTree from '@adguard/agtree'
import type { DomainOrigin, DomainRemovalTrigger, FileRewriteResult, RuleChange } from './types.ts'
import {
  DomainModifierNames,
  GetNetworkPatternDomain,
  IsCosmeticRule,
  IsNetworkRule,
  NormalizeDomain,
  ParseDomainList,
  ParseRule,
  SerializeDomainList,
  SplitLines
} from './rule-domains.ts'

export type DeadDomainsByOrigin = Record<DomainOrigin, Set<string>>
type DeadDomainInput = Set<string> | DeadDomainsByOrigin

type DomainListRewrite = {
  RemovedDomains: string[]
  HadPermittedDomains: boolean
  HasPermittedDomains: boolean
}

function ResolveDeadDomains(Input: DeadDomainInput): DeadDomainsByOrigin {
  if (Input instanceof Set) {
    return { networkPattern: Input, domainList: Input }
  }

  return Input
}

function CountPermitted(Domains: AGTree.Domain[]): number {
  return Domains.filter(Domain => !Domain.exception).length
}

function RewriteDomainListChildren(Domains: AGTree.Domain[], DeadDomains: Set<string>): {
  Kept: AGTree.Domain[]
  Rewrite: DomainListRewrite
} {
  const RemovedDomains: string[] = []
  const Kept: AGTree.Domain[] = []

  for (const Domain of Domains) {
    const Normalized = Domain.exception ? null : NormalizeDomain(Domain.value)

    if (Normalized && DeadDomains.has(Normalized)) {
      RemovedDomains.push(Normalized)
      continue
    }

    Kept.push(Domain)
  }

  return {
    Kept,
    Rewrite: {
      RemovedDomains,
      HadPermittedDomains: CountPermitted(Domains) > 0,
      HasPermittedDomains: CountPermitted(Kept) > 0
    }
  }
}

function RewriteModifiers(Modifiers: AGTree.ModifierList | undefined, DeadDomains: Set<string>): DomainListRewrite[] {
  const Rewrites: DomainListRewrite[] = []

  for (const Modifier of Modifiers?.children ?? []) {
    if (!Modifier.value || !DomainModifierNames.has(Modifier.name.value)) {
      continue
    }

    const DomainList = ParseDomainList(Modifier.value.value, Modifier.value.start ?? 0, AGTree.PIPE_MODIFIER_SEPARATOR)
    if (!DomainList) {
      continue
    }

    const { Kept, Rewrite } = RewriteDomainListChildren(DomainList.children, DeadDomains)
    if (Rewrite.RemovedDomains.length === 0) {
      continue
    }

    Modifier.value.value = SerializeDomainList(Kept)
    Rewrites.push(Rewrite)
  }

  return Rewrites
}

type RuleRewriteResult = {
  Text: string | null
  RemovedDomains: string[]
  Triggers: DomainRemovalTrigger[]
}

/**
 * Removes dead domain occurrences from a single rule.
 * Returns null text when a dead pattern makes the rule useless or a scoped rule would become global.
 */
export function RewriteRule(RawRule: string, DeadDomainInputValue: DeadDomainInput): RuleRewriteResult {
  const Rule = ParseRule(RawRule)
  const DeadDomains = ResolveDeadDomains(DeadDomainInputValue)

  if (!Rule || (!IsCosmeticRule(Rule) && !IsNetworkRule(Rule))) {
    return { Text: RawRule, RemovedDomains: [], Triggers: [] }
  }

  const PatternDomain = GetNetworkPatternDomain(Rule)
  if (PatternDomain && DeadDomains.networkPattern.has(PatternDomain)) {
    return {
      Text: null,
      RemovedDomains: [PatternDomain],
      Triggers: [{ Domain: PatternDomain, Origin: 'networkPattern' }]
    }
  }

  const NewRule = structuredClone(Rule)
  const Rewrites: DomainListRewrite[] = []

  if (IsCosmeticRule(NewRule) && NewRule.domains) {
    const { Kept, Rewrite } = RewriteDomainListChildren(NewRule.domains.children, DeadDomains.domainList)

    if (Rewrite.RemovedDomains.length > 0) {
      NewRule.domains.children = Kept
      Rewrites.push(Rewrite)
    }
  }

  Rewrites.push(...RewriteModifiers(NewRule.modifiers, DeadDomains.domainList))

  const RemovedDomains = Rewrites.flatMap(Rewrite => Rewrite.RemovedDomains)
  const Triggers = RemovedDomains.map(Domain => ({ Domain, Origin: 'domainList' as const }))
  if (RemovedDomains.length === 0) {
    return { Text: RawRule, RemovedDomains: [], Triggers: [] }
  }

  const LostAllDomains = Rewrites.some(Rewrite => Rewrite.HadPermittedDomains && !Rewrite.HasPermittedDomains)
  if (LostAllDomains) {
    return { Text: null, RemovedDomains, Triggers }
  }

  return { Text: AGTree.RuleGenerator.generate(NewRule), RemovedDomains, Triggers }
}

export function RewriteFilterContent(
  FilePath: string,
  Content: string,
  DeadDomainInputValue: DeadDomainInput
): FileRewriteResult {
  const Lines = SplitLines(Content)
  const OutputParts: string[] = []
  const ModifiedRules: RuleChange[] = []
  const RemovedRules: RuleChange[] = []

  for (let Index = 0; Index < Lines.length; Index += 1) {
    const Line = Lines[Index]
    const { Text, RemovedDomains, Triggers } = RewriteRule(Line.Text, DeadDomainInputValue)

    if (RemovedDomains.length === 0) {
      OutputParts.push(Line.Text + Line.LineEnding)
      continue
    }

    const Change: RuleChange = {
      FilePath,
      LineNumber: Index + 1,
      Before: Line.Text,
      After: Text,
      RemovedDomains,
      Triggers
    }

    if (Text === null) {
      RemovedRules.push(Change)
      continue
    }

    ModifiedRules.push(Change)
    OutputParts.push(Text + Line.LineEnding)
  }

  const NewContent = OutputParts.join('')

  return {
    Content: NewContent,
    Changed: NewContent !== Content,
    ModifiedRules,
    RemovedRules
  }
}
