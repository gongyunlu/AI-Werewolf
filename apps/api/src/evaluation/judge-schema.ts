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
