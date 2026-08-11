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

/**
 * 生成狼人团队的 threadId（用于狼人协作讨论）
 *
 * 格式：{gameId}-wolf-team
 *
 * @param gameId 游戏 ID
 * @returns threadId
 */
export function getWolfTeamThreadId(gameId: string): string {
  return `${gameId}-wolf-team`;
}

/**
 * 生成特定角色团队的 threadId（预留扩展）
 *
 * 格式：{gameId}-{role}-team
 *
 * @param gameId 游戏 ID
 * @param role 角色名称
 * @returns threadId
 */
export function getRoleTeamThreadId(gameId: string, role: string): string {
  return `${gameId}-${role}-team`;
}

/**
 * 从 threadId 解析出 playerId（用于调试和日志）
 *
 * @param threadId 线程 ID
 * @returns playerId 或 null
 */
export function parsePlayerIdFromThreadId(threadId: string): string | null {
  const match = threadId.match(/^[^-]+-player-(.+)$/);
  return match ? match[1] : null;
}

/**
 * 从 threadId 解析出 gameId（用于调试和日志）
 *
 * @param threadId 线程 ID
 * @returns gameId 或 null
 */
export function parseGameIdFromThreadId(threadId: string): string | null {
  const match = threadId.match(/^([^-]+)-/);
  return match ? match[1] : null;
}
