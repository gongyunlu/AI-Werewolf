import type { SpeechOrderConfig } from '../utils/speech-order.utils';

/**
 * Ruleset definition 的类型定义
 *
 * 对应 Prisma schema 中 Ruleset.definition 字段（JsonB）
 */
export interface RulesetDefinition {
  /**
   * 发言顺序规则配置
   */
  speechRules?: SpeechOrderConfig;

  /**
   * 角色配置
   */
  roles?: Array<{
    role: string;
    count: number;
  }>;

  /**
   * 夜晚行动顺序（角色代码数组）
   */
  nightOrder?: string[];

  /**
   * 其他规则配置（待补充）
   */
  // TODO: 补充其他规则配置类型
}
