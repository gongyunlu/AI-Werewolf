import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { gameLogger } from '../../utils/game-logger';

/**
 * 游戏结束节点工厂
 */
export const createGameEndNode: NodeFactory = (context) => {
  return async (state: GameGraphState) => {
    gameLogger.log(`[游戏结束] 胜方: ${state.winner}`);
    gameLogger.log(`[游戏结束] 总天数: ${state.currentDay}`);

    const alivePlayers = state.players.filter((p) => p.isAlive);
    gameLogger.debug(
      `[游戏结束] 存活玩家: ${alivePlayers.map((p) => `${p.seatNo}号位`).join(', ')}`,
    );

    await context.eventWriter.writeGameEndEvent({
      gameId: state.gameId,
      winner: state.winner ?? 'unknown',
    });
    context.broadcaster?.complete(state.gameId);

    return {};
  };
};
