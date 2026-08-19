import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { gameLogger } from '../../utils/game-logger';

/**
 * 初始化节点工厂
 */
export const createInitNode: NodeFactory = (context) => {
  return async (state: GameGraphState) => {
    gameLogger.log('[初始化] 游戏开始');

    // 验证玩家配置
    if (!state.players || state.players.length === 0) {
      throw new Error('[初始化] 玩家列表为空');
    }

    const event = await context.eventWriter.writeGameStartEvent({
      gameId: state.gameId,
      playerCount: state.players.length,
    });
    await context.eventBus?.publish(event);

    // 设置初始状态
    return {
      currentDay: 1,
      currentPhase: 'night' as const,
      isGameOver: false,
      winner: null,
      nextIsDay: false, // 初始化为 false（第一个阶段是 night）
    };
  };
};
