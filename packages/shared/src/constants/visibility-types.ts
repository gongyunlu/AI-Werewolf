import { z } from 'zod';

/**
 * Event 可见性类型
 *
 * 用于控制游戏事件的可见范围，确保信息按照狼人杀规则正确隔离
 */
export const VISIBILITY_TYPES = {
  /**
   * 公开可见：所有玩家都能看到
   *
   * 示例：白天发言、死讯公布、投票结果、放逐结果
   */
  PUBLIC: 'public',

  /**
   * 狼人团队可见：只有狼人能看到
   *
   * 示例：狼人夜间刀人决策
   */
  WOLF: 'wolf',

  /**
   * 预言家可见：只有预言家本人能看到
   *
   * 示例：预言家的查验结果
   */
  SEER: 'seer',

  /**
   * 女巫可见：只有女巫本人能看到
   *
   * 示例：女巫看到的刀口信息、女巫的用药决策
   */
  WITCH: 'witch',

  /**
   * 守卫可见：只有守卫本人能看到
   *
   * 示例：守卫的守护记录
   */
  GUARD: 'guard',

  /**
   * 系统内部：不对任何玩家可见
   *
   * 示例：调试日志、内部状态记录
   */
  SYSTEM: 'system',
} as const;

export type VisibilityType = typeof VISIBILITY_TYPES[keyof typeof VISIBILITY_TYPES];

const VISIBILITY_TYPES_ARRAY = Object.values(VISIBILITY_TYPES);
export const VisibilityTypeSchema = z.enum(VISIBILITY_TYPES_ARRAY as [string, ...string[]]);
