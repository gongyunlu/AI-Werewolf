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

    // 广播游戏结束
    const winnerName =
      state.winner === 'werewolf' ? '狼人' : state.winner === 'villager' ? '好人' : state.winner;
    context.broadcaster?.broadcastAnnouncement(
      state.gameId,
      'execute',
      state.currentDay,
      `游戏结束！${winnerName}阵营获胜！总天数：${state.currentDay}天`,
      'game_end',
    );

    // TODO: 写入游戏结果到数据库

    return {};
  };
};
