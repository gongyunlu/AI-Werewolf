import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';

/**
 * 白天公布死讯节点
 */
export const createAnnounceDayNode: NodeFactory = (context) => {
  return async (state: GameGraphState) => {
    const judgeEvent = await context.eventWriter.writeJudgeEvent({
      gameId: state.gameId,
      day: state.currentDay,
      content: `天亮了，第 ${state.currentDay} 天开始。`,
    });
    await context.eventBus?.publish(judgeEvent);

    if (state.nightDeaths?.length) {
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

      const deathEvent = await context.eventWriter.writeDeathAnnouncementEvent({
        gameId: state.gameId,
        day: state.currentDay,
        deaths,
      });
      await context.eventBus?.publish(deathEvent);
    } else {
      // 写入平安夜 Event
      const peacefulEvent = await context.eventWriter.writePeacefulNightEvent({
        gameId: state.gameId,
        day: state.currentDay,
      });
      await context.eventBus?.publish(peacefulEvent);
    }

    // 不修改状态，只是公布信息
    return {};
  };
};
