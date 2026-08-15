import type { GameGraphState } from '../../core/types';
import type { GameNode } from '../node.types';
import { ROLES } from '@ai-werewolf/shared';
import { gameLogger } from '../../utils/game-logger';

/**
 * 处理死亡触发技能节点
 *
 * 职责：
 * 1. 检查是否有玩家在本轮死亡
 * 2. 触发死亡时技能（猎人开枪、狼王开枪等）
 * 3. 更新玩家状态
 */
export const processDeathSkillsNode: GameNode = async (state: GameGraphState) => {
  // 收集所有死亡玩家
  const deadPlayers = state.players.filter((p) => !p.isAlive && p.deathDay === state.currentDay);

  if (deadPlayers.length === 0) {
    gameLogger.debug('[死亡技能] 无玩家死亡，跳过');
    return {};
  }

  gameLogger.debug(`[死亡技能] 处理 ${deadPlayers.length} 名死亡玩家的技能`);

  // 广播死亡技能检查（需要通过 context 传入 broadcaster）
  // TODO: 当前 processDeathSkillsNode 未使用 NodeFactory 模式，无法访问 context
  // 需要重构为 createProcessDeathSkillsNode(context) 后才能添加广播

  // TODO: 检查猎人
  const hunter = deadPlayers.find((p) => p.role === ROLES.HUNTER);
  if (hunter) {
    gameLogger.debug(`[死亡技能] 猎人 ${hunter.seatNo} 号位可以开枪`);
    // TODO: 派发猎人 Agent 选择开枪目标
    // TODO: 执行开枪
  }

  // TODO: 检查狼王
  const wolfKing = deadPlayers.find((p) => p.role === ROLES.WOLF_KING);
  if (wolfKing) {
    gameLogger.debug(`[死亡技能] 狼王 ${wolfKing.seatNo} 号位可以开枪`);
    // TODO: 派发狼王 Agent 选择开枪目标
    // TODO: 执行开枪
  }

  return {};
};
