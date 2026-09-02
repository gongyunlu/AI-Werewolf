import { z } from 'zod';

/**
 * 记忆固化的结构化输出：把 ≥3 条跨角色通用 lesson 提炼为 1 条 strategy。
 * title 作注入标题，content 作正文；长度上限与 reflection 的 lesson 对齐。
 */
export const ConsolidationOutputSchema = z.object({
  title: z.string().min(1).max(60),
  content: z.string().min(1).max(300),
});

export type ConsolidationOutput = z.infer<typeof ConsolidationOutputSchema>;
