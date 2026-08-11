import type { Ruleset } from '@/generated/prisma/client';
import type { RulesetDefinition } from '@/game-engine/core/ruleset-types';

/**
 * 带类型化 definition 的 Ruleset
 *
 * 用法：
 * ```typescript
 * const ruleset = await prisma.ruleset.findUnique({...}) as TypedRuleset | null;
 * const config = ruleset.definition.speechRules; // ✅ 有完整类型提示
 * ```
 */
export type TypedRuleset = Omit<Ruleset, 'definition'> & {
  definition: RulesetDefinition;
};
