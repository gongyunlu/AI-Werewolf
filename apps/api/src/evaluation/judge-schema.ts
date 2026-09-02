import { z } from 'zod';

/** 决策质量等级（三档，DB 存字符串，与项目既有字符串存储风格一致） */
export const JUDGE_VERDICTS = ['good', 'fair', 'poor'] as const;
export const JudgeVerdictSchema = z.enum(JUDGE_VERDICTS);
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

/** judge 结构化输出：等级 + 0-100 分 + 一句理由 */
export const JudgeOutputSchema = z.object({
  verdict: JudgeVerdictSchema,
  score: z.number().int().min(0).max(100),
  reasoning: z.string().min(1).max(500),
});
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

/**
 * 发言批量评估的结构化输出。
 *
 * index 对应 prompt 时间线里的 `[发言#n]` 序号，是评分映射回具体事件的唯一依据。
 * 弱模型（deepseek-v4-flash 等）在 jsonSchema 结构化输出下频繁漏标 index（1~2 条发言也漏），
 * prompt 强调 + 单次重试仍拦不住，反复失败重试白烧调用，故放宽为可选。
 * 运行时只在「条数对齐且全部漏标」时按输出顺序回填（全漏标说明模型只是没写该字段而非乱序，
 * 顺序即时间线顺序，无错位风险）；部分漏标仍由 validateSpeechOutput 抛错重试，不静默错位。
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
 * zod 能保证「index 是正整数」，表达不了「落在 1..targetCount 且唯一」这类
 * 依赖运行时 targetCount 的约束，故在 upsert 前补一层后校验：
 * 非法输出抛错让 job 失败重试，而不是静默错位写入。
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
