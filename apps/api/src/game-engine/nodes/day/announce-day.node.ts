import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { gameLogger } from '../../utils/game-logger';

/**
 * 白天公布死讯节点
 */
export const createAnnounceDayNode: NodeFactory = (context) => {
  return async (state: GameGraphState) => {
    if (state.nightDeaths?.length) {
      const deadPlayerIds = state.nightDeaths.map((d) => d.playerId).join(', ');
      gameLogger.log(`[死亡公告] 昨晚死亡的玩家: ${deadPlayerIds}`);

      // 写入死亡公告 Event
      const deaths = state.nightDeaths.map((d) => {
        const player = state.players.find((p) => p.id === d.playerId);
        if (!player) {
          throw new Error(`[白天公布] 数据不一致：玩家 ${d.playerId} 不存在于 state.players`);
        }
        return {
          playerId: d.playerId,
          seatNo: player.seatNo,
          cause: d.cause,
        };
      });

      await context.eventWriter.writeDeathAnnouncementEvent({
        gameId: state.gameId,
        day: state.currentDay,
        deaths,
      });
    } else {
      gameLogger.log(`[死亡公告] 昨晚平安夜`);

      // 写入平安夜 Event
      await context.eventWriter.writePeacefulNightEvent({
        gameId: state.gameId,
        day: state.currentDay,
      });
    }

    // 不修改状态，只是公布信息
    return {};
  };
};
