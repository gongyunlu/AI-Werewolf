import { Logger } from '@nestjs/common';
import { FACTIONS } from '@ai-werewolf/shared';
import type { GameGraphState } from '../../core/types';
import type { GameNode } from '../node.types';
import { checkWinConditionPhase } from '../../coordinators/phase-resolvers';

/**
 * 胜负判定节点
 *
 * 职责：
 * 1. 判断游戏是否结束
 * 2. 确定获胜方
 *
 * 规则：
 * - 狼人全灭 → 好人胜利
 * - 好人数 ≤ 狼人数 → 狼人胜利
 * - 屠边（神职全灭或平民全灭）→ 狼人胜利
 * - 人狼恋存活且其他人全灭 → 第三方胜利
 *
 * 输入：GameGraphState
 * 输出：{ isGameOver: boolean, winner?: string }
 */
export const checkWinNode: GameNode = async (state: GameGraphState) => {
  const logger = new Logger('CheckWinNode');

  logger.log(`[胜负判定] Day ${state.currentDay} 判定`);

  // 统计存活玩家（调试用）
  const alive = state.players.filter((p) => p.isAlive);
  const aliveWerewolves = alive.filter((p) => p.faction === FACTIONS.WEREWOLF);
  const aliveVillagers = alive.filter((p) => p.faction === FACTIONS.VILLAGER);

  logger.debug(
    `[胜负判定] 存活统计: 总${alive.length}人, 狼${aliveWerewolves.length}人(${aliveWerewolves.map((w) => `${w.seatNo}号`).join(', ')}), 好人${aliveVillagers.length}人(${aliveVillagers.map((v) => `${v.seatNo}号`).join(', ')})`,
  );

  // 复用已有的逻辑
  const result = await checkWinConditionPhase(state);

  if (result.isGameOver) {
    logger.log(`[胜负判定] 游戏结束，胜方: ${result.winner}`);
  } else {
    logger.log(`[胜负判定] 游戏继续`);
  }

  return result;
};
