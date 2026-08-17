import { DEATH_CAUSES } from '@ai-werewolf/shared';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { gameLogger } from '../../utils/game-logger';

/**
 * 放逐执行节点
 *
 * 规则：
 * - 放逐目标立即死亡
 * - 记录死亡原因为 DEATH_CAUSES.EXECUTION
 * - 记录死亡时间为当前天数
 */
export const createExecuteNode: NodeFactory = (context) => {
  return async (state: GameGraphState): Promise<Partial<GameGraphState>> => {
    gameLogger.debug(`[放逐执行] Day ${state.currentDay} 执行放逐`);

    const { exileTarget } = state;

    if (!exileTarget) {
      gameLogger.warn('[放逐执行] 无放逐目标，跳过');
      return {};
    }

    const target = state.players.find((p) => p.id === exileTarget);
    if (!target) {
      throw new Error(`[放逐执行] 数据一致性错误：未找到放逐目标玩家 ${exileTarget}`);
    }

    gameLogger.log(`[放逐执行] 放逐 ${target.seatNo}号位 (${target.role})`);

    // 法官播报：执行放逐

    // 更新玩家状态
    const updatedPlayers = state.players.map((p) => {
      if (p.id === exileTarget) {
        return {
          ...p,
          isAlive: false,
          deathDay: state.currentDay,
          deathCause: DEATH_CAUSES.EXECUTION,
        };
      }
      return p;
    });

    // 写入 Event 表
    await context.eventWriter.writePlayerExiledEvent({
      gameId: state.gameId,
      day: state.currentDay,
      targetId: target.id,
      targetSeatNo: target.seatNo,
      voteCount: state.exileVoteCount || 0,
    });

    // 同步死亡状态到数据库
    await context.prisma.player.update({
      where: { id: target.id },
      data: {
        deathDay: state.currentDay,
        deathCause: DEATH_CAUSES.EXECUTION,
      },
    });

    gameLogger.debug(`[放逐执行] ${target.seatNo}号位已出局`);

    return {
      players: updatedPlayers,
      exileTarget: null,
    };
  };
};
