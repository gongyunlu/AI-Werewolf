import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { gameLogger } from '../../utils/game-logger';

/**
 * 白天公布死讯节点
 */
export const createAnnounceDayNode: NodeFactory = (context) => {
  return async (state: GameGraphState) => {
    // 法官播报：天亮了
    context.broadcaster?.broadcastAnnouncement(
      state.gameId,
      'day_announce',
      state.currentDay,
      `天亮了，第 ${state.currentDay} 天开始。`,
    );

    if (state.nightDeaths?.length) {
      const deadPlayerIds = state.nightDeaths.map((d) => d.playerId).join(', ');
      gameLogger.log(`[死亡公告] 昨晚死亡的玩家: ${deadPlayerIds}`);

      // 法官播报死讯
      const seatNos = state.nightDeaths
        .map((d) => state.players.find((p) => p.id === d.playerId)?.seatNo)
        .filter(Boolean)
        .join('号、');
      context.broadcaster?.broadcastAnnouncement(
        state.gameId,
        'day_announce',
        state.currentDay,
        `昨晚，${seatNos}号玩家死亡。`,
      );

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

      // 法官播报：平安夜
      context.broadcaster?.broadcastAnnouncement(
        state.gameId,
        'day_announce',
        state.currentDay,
        '昨晚是平安夜，无人死亡。',
      );

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
