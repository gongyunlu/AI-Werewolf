/**
 * Thread ID 生成工具
 *
 * 统一管理 Agent 会话的 threadId 生成逻辑
 */

/**
 * 生成玩家的 threadId
 *
 * 格式：{gameId}-player-{playerId}
 *
 * @param gameId 游戏 ID
 * @param playerId 玩家 ID
 * @returns threadId
 */
export function getPlayerThreadId(gameId: string, playerId: string): string {
  return `${gameId}-player-${playerId}`;
}
