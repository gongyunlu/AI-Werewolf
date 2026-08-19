import { z } from 'zod';

// 预言家查验结果枚举
export const SEER_CHECK_RESULTS = {
  GOOD: 'good', // 好人
  WEREWOLF: 'werewolf', // 狼人
} as const;

export type SeerCheckResult = (typeof SEER_CHECK_RESULTS)[keyof typeof SEER_CHECK_RESULTS];

const SEER_CHECK_RESULTS_ARRAY = Object.values(SEER_CHECK_RESULTS);
export const SeerCheckResultSchema = z.enum(SEER_CHECK_RESULTS_ARRAY as [string, ...string[]]);
