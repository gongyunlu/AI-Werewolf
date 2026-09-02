import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { gameLogger } from '../../utils/game-logger';

async function notifyBestEffort(label: string, notify: () => void | Promise<void>): Promise<void> {
  try {
    await notify();
  } catch (error) {
    gameLogger.error(
      `[游戏结束] ${label}失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * 游戏结束节点工厂
 */
export const createGameEndNode: NodeFactory = (context) => {
  return async (state: GameGraphState) => {
    // EventWriter 在同一 Prisma transaction 内写结束事件并切换 FINISHED；
    // 任一步失败都会整体回滚，不留下互相矛盾的两份终局事实。
    const event = await context.eventWriter.writeGameEndEvent({
      gameId: state.gameId,
      winner: state.winner ?? 'unknown',
      winnerFaction: state.winner,
      totalDays: state.currentDay,
      endedAt: new Date(),
    });

    // 三类通知各自 best-effort。前一项失败不能短路后一项，尤其必须尝试关闭 SSE。
    if (context.eventBus) {
      await notifyBestEffort('结束事件发布', () => context.eventBus!.publish(event));
    }
    if (context.broadcaster) {
      await notifyBestEffort('结束消息广播', () =>
        context.broadcaster!.emit(state.gameId, {
          type: 'game.finished',
          winner: state.winner ?? 'unknown',
        }),
      );
      await notifyBestEffort('SSE 关闭', () => context.broadcaster!.complete(state.gameId));
    }

    return {};
  };
};
