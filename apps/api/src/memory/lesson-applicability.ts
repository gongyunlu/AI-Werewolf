import { KnowledgeApplicabilitySchema } from '../knowledge/knowledge-policy';

export const LessonConditionsSchema = KnowledgeApplicabilitySchema.shape.allFacts;

/** 旧记录没有结构化条件时保留原筛选；已标注条件必须全部由可见事件证明。 */
export function lessonApplies(metadata: unknown, facts: string[]): boolean {
  const conditions = (metadata as { conditions?: unknown } | null)?.conditions;
  if (conditions === undefined) return true;
  return LessonConditionsSchema.parse(conditions).every((condition) => facts.includes(condition));
}
