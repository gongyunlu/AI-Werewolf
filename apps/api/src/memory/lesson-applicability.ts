import { KnowledgeApplicabilitySchema } from '../knowledge/knowledge-policy';

export const LessonConditionsSchema = KnowledgeApplicabilitySchema.shape.allFacts;

/** 缺少适用条件的旧经验不进入玩家上下文；条件必须由当前可见事实证明。 */
export function lessonApplies(metadata: unknown, facts: string[]): boolean {
  const conditions = (metadata as { conditions?: unknown } | null)?.conditions;
  if (conditions === undefined) return false;
  const parsed = LessonConditionsSchema.safeParse(conditions);
  return parsed.success && parsed.data.every((condition) => facts.includes(condition));
}
