import type { PlayerState } from '../core/types';

export interface VoteResolutionResult {
  executedPlayerId: string | null; // 被放逐的玩家 ID，null 表示无人出局
  isTie: boolean;
  tiedPlayerIds: string[]; // 平票时并列最高票的玩家 ID 列表
}

/**
 * 计票逻辑：唯一最高票放逐、平票处理、无人投票、警长票权
 *
 * 规则：
 * - 唯一最高票者出局
 * - 多人并列最高票时平票，无人出局
 * - 无人投票时无人出局
 * - 死亡玩家的投票无效
 * - 投给死亡玩家的票无效
 * - 警长的票算 1.5 票
 */
export function resolveVotes(
  votes: Map<string, string[]>, // 被投票人 ID → 投票人 ID[]
  players: PlayerState[],
  sheriffId?: string | null,
): VoteResolutionResult {
  const alivePlayerIds = new Set(players.filter((p) => p.isAlive).map((p) => p.id));

  // 过滤：只保留「存活玩家投给存活玩家」的票
  const validVotes = new Map<string, string[]>();
  for (const [targetId, voterIds] of votes.entries()) {
    if (!alivePlayerIds.has(targetId)) {
      continue; // 投给死人的票无效
    }
    const validVoterIds = voterIds.filter((voterId) => alivePlayerIds.has(voterId));
    if (validVoterIds.length > 0) {
      validVotes.set(targetId, validVoterIds);
    }
  }

  // 无有效投票
  if (validVotes.size === 0) {
    return {
      executedPlayerId: null,
      isTie: false,
      tiedPlayerIds: [],
    };
  }

  // 统计票数（警长票权 1.5）
  const voteCounts = new Map<string, number>();
  for (const [targetId, voterIds] of validVotes.entries()) {
    const count = voterIds.reduce((sum, voterId) => {
      return sum + (sheriffId && voterId === sheriffId ? 1.5 : 1.0);
    }, 0);
    voteCounts.set(targetId, count);
  }

  // 找出最高票数
  const maxVotes = Math.max(...voteCounts.values());

  // 找出所有获得最高票的玩家
  const topPlayers = Array.from(voteCounts.entries())
    .filter(([, count]) => count === maxVotes)
    .map(([playerId]) => playerId);

  // 唯一最高票
  if (topPlayers.length === 1) {
    return {
      executedPlayerId: topPlayers[0],
      isTie: false,
      tiedPlayerIds: [],
    };
  }

  // 平票
  return {
    executedPlayerId: null,
    isTie: true,
    tiedPlayerIds: topPlayers,
  };
}
