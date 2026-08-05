import { z } from 'zod';

// Agent 私有记忆类型枚举
export const MEMORY_TYPES = [
  'lesson', // 教训
  'observation', // 观察
  'reflection', // 反思
  'strategy', // 策略
  'player_model', // 对手建模
  'pattern', // 模式规律
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export const MemoryTypeSchema = z.enum(MEMORY_TYPES);
