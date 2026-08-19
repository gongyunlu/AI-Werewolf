import { SEER_CHECK_RESULTS, type SeerCheckResult } from '@ai-werewolf/shared';

/**
 * Event content 类型定义
 *
 * 根据 actionType 的不同，content 的结构也不同
 */

/**
 * 预言家查验事件 content
 */
export interface SeerCheckEventContent {
  targetSeatNo: number;
  result: SeerCheckResult;
}

/**
 * 狼人刀人事件 content
 */
export interface WolfKillEventContent {
  targetSeatNo: number;
  cause: 'night_kill';
}

/**
 * 女巫解药事件 content
 */
export interface WitchAntidoteEventContent {
  targetSeatNo: number;
  saved: boolean;
}

/**
 * 女巫毒药事件 content
 */
export interface WitchPoisonEventContent {
  targetSeatNo: number;
  cause: 'witch_poison';
}

/**
 * 死亡公告事件 content
 */
export interface DeathAnnouncementEventContent {
  deaths: Array<{
    seatNo: number;
    cause: string;
  }>;
}

/**
 * 平安夜事件 content
 */
export interface PeacefulNightEventContent {
  message: string;
}

/**
 * Event content 联合类型
 */
export type EventContent =
  | SeerCheckEventContent
  | WolfKillEventContent
  | WitchAntidoteEventContent
  | WitchPoisonEventContent
  | DeathAnnouncementEventContent
  | PeacefulNightEventContent;

/**
 * 类型守卫：判断是否为预言家查验事件
 */
export function isSeerCheckEventContent(content: unknown): content is SeerCheckEventContent {
  return (
    typeof content === 'object' &&
    content !== null &&
    'targetSeatNo' in content &&
    'result' in content &&
    ((content as Record<string, unknown>).result === SEER_CHECK_RESULTS.GOOD ||
      (content as Record<string, unknown>).result === SEER_CHECK_RESULTS.WEREWOLF)
  );
}

/**
 * 类型守卫：判断是否为死亡公告事件
 */
export function isDeathAnnouncementEventContent(
  content: unknown,
): content is DeathAnnouncementEventContent {
  return (
    typeof content === 'object' &&
    content !== null &&
    'deaths' in content &&
    Array.isArray((content as Record<string, unknown>).deaths)
  );
}
