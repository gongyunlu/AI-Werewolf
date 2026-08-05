import { z } from 'zod';

// 模型调用目的枚举
export const PURPOSES = [
  'night_action', // 夜间行动决策
  'speech', // 发言生成
  'vote', // 投票决策
  'reflection', // 复盘反思
  'system', // 系统级调用
  'memory_extraction', // 记忆提炼
  'analysis', // 分析
] as const;
export type Purpose = (typeof PURPOSES)[number];
export const PurposeSchema = z.enum(PURPOSES);
