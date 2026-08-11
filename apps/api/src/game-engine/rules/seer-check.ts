import { FACTIONS } from '@ai-werewolf/shared';
import type { PlayerState } from '../core/types';
import { ROLES } from '@ai-werewolf/shared';

export type SeerCheckResult = 'good' | 'werewolf';

/**
 * 预言家查验结果生成逻辑
 *
 * 规则：
 * 1. 预言家只能查阵营（好人/狼人），不能查具体角色
 * 2. 隐狼特殊：查验显示为好人
 * 3. 其他玩家：根据阵营返回结果
 *
 * @param player 被查验的玩家
 * @returns 查验结果：'good'（好人）或 'werewolf'（狼人）
 */
export function checkSeerResult(player: PlayerState): SeerCheckResult {
  // 隐狼特殊处理：查验显示为好人
  if (player.role === ROLES.HIDDEN_WOLF) {
    return 'good';
  }

  // 其他玩家：根据阵营返回结果
  return player.faction === FACTIONS.WEREWOLF ? 'werewolf' : 'good';
}
