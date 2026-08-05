import { z } from 'zod';

// 全局共享记忆类型枚举
export const GLOBAL_MEMORY_TYPES = [
  'statistics', // 统计规律
  'meta_strategy', // 元策略
  'pattern', // 模式规律
  'rule_interpretation', // 规则解读
  'common_sense', // 常识
] as const;
export type GlobalMemoryType = (typeof GLOBAL_MEMORY_TYPES)[number];
export const GlobalMemoryTypeSchema = z.enum(GLOBAL_MEMORY_TYPES);
