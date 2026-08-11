import { Logger } from '@nestjs/common';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { resolveNightPhase } from '../../coordinators/phase-resolvers';

/**
 * 夜间结算节点
 */
export const createNightResolveNode: NodeFactory = (context) => {
  const logger = new Logger('NightResolveNode');

  return async (state: GameGraphState) => {
    logger.log('[夜间结算] 开始结算');

    // 复用已有的结算逻辑
    const result = await resolveNightPhase(state);

    logger.log(`[夜间结算] 完成，死亡人数: ${result.nightDeaths?.length ?? 0}`);

    // 更新数据库中的玩家死亡状态
    if (result.players) {
      // 查找本轮死亡的玩家
      const deadPlayers = result.players.filter(
        (p) => !p.isAlive && p.deathDay === state.currentDay,
      );

      // 批量更新死亡玩家的状态
      for (const player of deadPlayers) {
        await context.prisma.player.update({
          where: { id: player.id },
          data: {
            deathDay: player.deathDay,
            deathCause: player.deathCause,
          },
        });
      }
    }

    return result;
  };
};
