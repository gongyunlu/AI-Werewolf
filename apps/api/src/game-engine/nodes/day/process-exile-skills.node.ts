import { Logger } from '@nestjs/common';
import { DEATH_CAUSES } from '@ai-werewolf/shared';
import type { GameGraphState, GameGraphUpdate } from '../../core/types';
import type { NodeContext, GameNode } from '../node.types';
import { resolveSpecialRoleTriggers } from '../../rules/special-role-trigger';

const logger = new Logger('ProcessExileSkillsNode');

/**
 * 处理放逐触发技能节点工厂
 */
export function createProcessExileSkillsNode(context: NodeContext): GameNode {
  return async (state: GameGraphState): Promise<GameGraphUpdate> => {
    return processExileSkillsNode(state, context);
  };
}

/**
 * 处理放逐触发技能节点
 *
 * 职责：
 * 1. 检查被放逐玩家是否触发特殊技能
 * 2. 触发技能：猎人开枪、狼王开枪、白痴翻牌、白狼王自爆带人
 * 3. 更新玩家状态
 *
 * 规则：
 * - 猎人：被放逐时可以开枪
 * - 狼王：被放逐、被刀、被猎人射杀时可以开枪
 * - 白痴：被放逐时翻牌免疫死亡
 * - 白狼王：自爆时可以带走一人
 *
 * @param state 游戏状态
 * @param context 节点上下文
 * @returns 状态更新
 */
async function processExileSkillsNode(
  state: GameGraphState,
  context: NodeContext,
): Promise<GameGraphUpdate> {
  logger.log(`[放逐技能] Day ${state.currentDay} 开始处理`);

  // 查询刚被放逐的玩家
  const exiledPlayer = state.players.find(
    (p) => !p.isAlive && p.deathDay === state.currentDay && p.deathCause === DEATH_CAUSES.EXECUTION,
  );

  if (!exiledPlayer) {
    logger.log(`[放逐技能] 本轮无人被放逐，跳过`);
    return {};
  }

  logger.log(`[放逐技能] 检查 ${exiledPlayer.seatNo}号位 (${exiledPlayer.role}) 的技能触发`);

  // 使用 special-role-trigger 逻辑判断技能触发
  const triggerResult = resolveSpecialRoleTriggers({
    players: state.players,
    executedPlayerId: exiledPlayer.id,
    executedCause: 'execution',
  });

  let updatedPlayers = state.players;

  // 处理白痴翻牌
  if (triggerResult.idiotRevealed) {
    logger.log(`[放逐技能] 白痴 ${exiledPlayer.seatNo}号位翻牌，免疫死亡`);

    // 白痴存活，撤销死亡状态
    updatedPlayers = updatedPlayers.map((p) => {
      if (p.id === triggerResult.idiotPlayerId) {
        return {
          ...p,
          isAlive: true,
          deathDay: null,
          deathCause: null,
        };
      }
      return p;
    });

    // 写入白痴翻牌事件
    await context.eventWriter.writeIdiotRevealEvent({
      gameId: state.gameId,
      day: state.currentDay,
      playerId: exiledPlayer.id,
      seatNo: exiledPlayer.seatNo,
    });
  }

  // 处理猎人开枪
  if (triggerResult.hunterCanShoot) {
    logger.log(`[放逐技能] 猎人 ${exiledPlayer.seatNo}号位可以开枪`);

    // TODO: 派发猎人 Agent 选择开枪目标
    // TODO: 执行开枪，更新 updatedPlayers
    logger.warn(`[放逐技能] 猎人开枪逻辑待实现`);
  }

  // 处理狼王开枪
  if (triggerResult.wolfKingCanShoot) {
    logger.log(`[放逐技能] 狼王 ${exiledPlayer.seatNo}号位可以开枪`);

    // TODO: 派发狼王 Agent 选择开枪目标
    // TODO: 执行开枪，更新 updatedPlayers
    logger.warn(`[放逐技能] 狼王开枪逻辑待实现`);
  }

  // 处理白狼王自爆带人
  if (triggerResult.whiteWolfCanKill) {
    logger.log(`[放逐技能] 白狼王 ${exiledPlayer.seatNo}号位自爆可以带走一人`);

    // TODO: 派发白狼王 Agent 选择带走目标
    // TODO: 执行带走，更新 updatedPlayers
    logger.warn(`[放逐技能] 白狼王自爆带人逻辑待实现`);
  }

  logger.log(`[放逐技能] 处理完成`);

  return {
    players: updatedPlayers,
  };
}
