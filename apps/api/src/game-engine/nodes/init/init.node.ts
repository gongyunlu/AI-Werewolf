import type { GameGraphState } from '../../core/types';
import type { GameNode } from '../node.types';
import { gameLogger } from '../../utils/game-logger';

/**
 * 初始化节点
 *
 * 职责：
 * 1. 验证游戏配置
 * 2. 初始化玩家状态
 * 3. 设置初始阶段和天数
 *
 * 输入：GameGraphState（可能是空的或部分初始化的）
 * 输出：完整的初始化状态
 */
export const initNode: GameNode = async (state: GameGraphState) => {
  gameLogger.log('[初始化] 游戏开始');

  // 验证玩家配置
  if (!state.players || state.players.length === 0) {
    throw new Error('[初始化] 玩家列表为空');
  }

  gameLogger.debug(`[初始化] 玩家数量: ${state.players.length}`);

  // 设置初始状态
  return {
    currentDay: 1,
    currentPhase: 'night' as const,
    isGameOver: false,
    winner: null,
    nextIsDay: false, // 初始化为 false（第一个阶段是 night）
  };
};
