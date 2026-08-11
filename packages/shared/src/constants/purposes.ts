import { z } from 'zod';

// 模型调用目的枚举
export const PURPOSES = {
  NIGHT_ACTION: 'night_action', // 夜间行动决策
  SPEECH: 'speech', // 发言生成
  VOTE: 'vote', // 投票决策
  REFLECTION: 'reflection', // 复盘反思
  SYSTEM: 'system', // 系统级调用
  MEMORY_EXTRACTION: 'memory_extraction', // 记忆提炼
  ANALYSIS: 'analysis', // 分析
} as const;

export type Purpose = typeof PURPOSES[keyof typeof PURPOSES];

const PURPOSES_ARRAY = Object.values(PURPOSES);
export const PurposeSchema = z.enum(PURPOSES_ARRAY as [string, ...string[]]);
