import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { GAME_STATUSES } from '@ai-werewolf/shared';

/**
 * 游戏结束节点工厂
 */
export const createGameEndNode: NodeFactory = (context) => {
  return async (state: GameGraphState) => {
    await context.prisma.game.update({
      where: { id: state.gameId },
      data: {
        status: GAME_STATUSES.FINISHED,
        winnerFaction: state.winner ?? undefined,
        totalDays: state.currentDay,
        endedAt: new Date(),
      },
    });

    const event = await context.eventWriter.writeGameEndEvent({
      gameId: state.gameId,
      winner: state.winner ?? 'unknown',
    });
    await context.eventBus?.publish(event);
    context.broadcaster?.emit(state.gameId, {
      type: 'game.finished',
      winner: state.winner ?? 'unknown',
    });
    context.broadcaster?.complete(state.gameId);

    return {};
  };
};
