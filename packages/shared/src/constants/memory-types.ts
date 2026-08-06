import { z } from 'zod';

// Agent 私有记忆类型枚举
export const MEMORY_TYPES = [
  'persona', // 人设：表达风格、思维习惯、情绪特征等长期稳定的身份特质
  'lesson', // 教训
  'observation', // 观察
  'reflection', // 反思
  'strategy', // 策略：战术倾向，需与角色、局面共同决定行动
  'player_model', // 对手建模
  'pattern', // 模式规律
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export const MemoryTypeSchema = z.enum(MEMORY_TYPES);
