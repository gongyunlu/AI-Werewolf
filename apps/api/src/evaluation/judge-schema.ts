import { z } from 'zod';

/** 决策质量等级（三档，DB 存字符串，与项目既有字符串存储风格一致） */
export const JUDGE_VERDICTS = ['good', 'fair', 'poor'] as const;
export const JudgeVerdictSchema = z.enum(JUDGE_VERDICTS);
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

/** judge 结构化输出：等级 + 0-100 分 + 一句理由 */
export const JudgeOutputSchema = z.object({
  verdict: JudgeVerdictSchema,
  score: z.number().int().min(0).max(100),
  reasoning: z
    .string()
    .min(1)
    .max(500)
    .refine((text) => text.trim().length > 0, '理由不能只有空白'),
});
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

/**
 * 发言批量评估的结构化输出。
 *
 * index 对应 prompt 时间线里的 `[发言#n]` 序号，是评分映射回具体事件的唯一依据。
 * 保留既有兼容规则：条数对齐且全部漏标时，按时间线顺序解释；部分漏标拒绝采用。
 * 目标数量、索引范围和唯一性在阶段结果保存前校验，失败进入统一的输出修正政策。
 */
export const SpeechJudgeOutputSchema = z.object({
  items: z
    .array(
      JudgeOutputSchema.extend({
        index: z.number().int().positive().optional(),
      }),
    )
    .min(1),
});
export type SpeechJudgeOutput = z.infer<typeof SpeechJudgeOutputSchema>;

/**
 * 运行时校验发言评分的 index 映射能否安全落到事件。
 *
 * 由动态 Schema 传入本次目标数量，拒绝缺失、越界或重复的索引。
 */
export function validateSpeechOutput(items: SpeechJudgeOutput['items'], targetCount: number): void {
  if (items.length !== targetCount) {
    throw new Error(`发言评分数量不匹配：期望 ${targetCount} 条，实际 ${items.length} 条`);
  }

  const seen = new Set<number>();
  for (const item of items) {
    const idx = item.index;
    if (idx == null) {
      throw new Error('发言评分 index 缺失（部分漏标，拒绝按顺序猜测归属）');
    }
    if (idx < 1 || idx > targetCount) {
      throw new Error(`发言评分 index 越界：${idx}（合法范围 1..${targetCount}）`);
    }
    if (seen.has(idx)) {
      throw new Error(`发言评分 index 重复：${idx}`);
    }
    seen.add(idx);
  }
}

/** 先完成目标映射校验，再允许阶段结果进入恢复缓存。 */
export function speechJudgeSchema(targetCount: number) {
  return SpeechJudgeOutputSchema.superRefine((output, ctx) => {
    const items = output.items.every((item) => item.index == null)
      ? output.items.map((item, index) => ({ ...item, index: index + 1 }))
      : output.items;
    try {
      validateSpeechOutput(items, targetCount);
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message });
    }
  });
}
