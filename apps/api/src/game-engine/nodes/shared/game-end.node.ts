import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';

/**
 * 游戏结束节点工厂
 */
export const createGameEndNode: NodeFactory = (context) => {
  return async (state: GameGraphState) => {
    // EventWriter 在同一 Prisma transaction 内写结束事件并切换 FINISHED；
    // 任一步失败都会整体回滚，不留下互相矛盾的两份终局事实。
    const event = await context.eventWriter.writeGameEndEvent({
      phaseInstanceId: state.phaseInstanceId,
      signal: context.signal,
      gameId: state.gameId,
      winner: state.winner ?? 'unknown',
      winnerFaction: state.winner,
      totalDays: state.currentDay,
    });

    // 只唤醒持久消费者；终局的最终内容发送后由消费者关闭流，不能先清空待交付内容。
    await context.eventBus?.publish(event);

    return {};
  };
};
