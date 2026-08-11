import { Logger } from '@nestjs/common';
import type { GameGraphState } from '../../core/types';
import type { GameNode } from '../node.types';

/**
 * 游戏结束节点
 *
 * 职责：
 * 1. 广播最终结果
 * 2. 记录游戏日志
 * 3. 清理资源
 *
 * 输入：GameGraphState（isGameOver = true）
 * 输出：最终状态
 */
export const gameEndNode: GameNode = async (state: GameGraphState) => {
  const logger = new Logger('GameEndNode');

  logger.log(`[游戏结束] 胜方: ${state.winner}`);
  logger.log(`[游戏结束] 总天数: ${state.currentDay}`);

  const alivePlayers = state.players.filter((p) => p.isAlive);
  logger.log(`[游戏结束] 存活玩家: ${alivePlayers.map((p) => `${p.seatNo}号位`).join(', ')}`);

  // TODO: 写入游戏结果到数据库
  // TODO: 广播最终结果到所有玩家

  return {};
};
