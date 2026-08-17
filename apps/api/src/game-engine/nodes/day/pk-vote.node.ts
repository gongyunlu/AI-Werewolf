import type { NodeFactory } from '../node.types';
import type { GameGraphState } from '../../core/types';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { AGENT_SCENARIOS } from '@ai-werewolf/shared';
import { createCastVoteTool, type CastVoteOutput } from '@/agent-runtime/tools/cast-vote.tool';
import { resolveVotes } from '../../rules/vote-resolution';
import { gameLogger } from '../../utils/game-logger';

/**
 * PK 投票节点
 *
 * 平票后，除 PK 候选人外的其他玩家进行投票
 * 只能投给 PK 候选人，不能弃票
 */
export const createPkVoteNode: NodeFactory = (context) => {
  return async (state: GameGraphState): Promise<Partial<GameGraphState>> => {
    gameLogger.debug(`[PK投票] Day ${state.currentDay} - PK轮次 ${state.pkRound}`);

    // 检查是否有 PK 候选人
    if (!state.pkCandidates || state.pkCandidates.length === 0) {
      gameLogger.debug('[PK投票] 无PK候选人，跳过');
      return {};
    }

    gameLogger.debug(`[PK投票] PK候选人: ${state.pkCandidates.join(', ')}号位`);

    // 获取所有存活玩家（排除 PK 候选人）
    const alivePlayers = state.players.filter((p) => p.isAlive);
    const voters = alivePlayers.filter((p) => !state.pkCandidates!.includes(p.seatNo!));

    if (voters.length === 0) {
      gameLogger.warn('[PK投票] 没有可投票的玩家（所有存活玩家都在PK台上），跳过放逐');
      return {
        exileTarget: null,
        exileVoteCount: 0,
        pkCandidates: null,
        pkRound: 0,
      };
    }

    gameLogger.debug(`[PK投票] 投票玩家: ${voters.map((p) => p.seatNo).join(', ')}号位`);

    // 并行投票
    const votePromises = voters.map(async (player) => {
      gameLogger.debug(`[PK投票] ${player.seatNo}号位开始投票...`);

      try {
        const tools = [
          createCastVoteTool({
            gameId: state.gameId,
            currentPlayerId: player.id,
            allowAbstain: false, // PK投票不允许弃票
            validTargets: state.pkCandidates ?? undefined, // 只能投给PK候选人
          }),
        ];

        const result = await context.agentRuntime.run({
          gameId: state.gameId,
          playerId: player.id,
          scenario: AGENT_SCENARIOS.VOTE,
          availableTools: tools,
          maxIterations: 3,
          threadId: getPlayerThreadId(state.gameId, player.id),
          additionalContext: `这是PK投票，你只能投给以下候选人之一: ${state.pkCandidates!.join(', ')}号位。不能弃票。`,
        });

        if (result.success && result.result) {
          const toolResult = result.result as CastVoteOutput;

          if (toolResult.action === 'cast_vote') {
            gameLogger.debug(`[PK投票] ${player.seatNo}号位投票给 ${toolResult.targetSeatNo}号位`);

            await context.eventWriter.writePlayerVoteEvent({
              gameId: state.gameId,
              day: state.currentDay,
              actorId: player.id,
              voterSeatNo: player.seatNo!,
              targetSeatNo: toolResult.targetSeatNo,
            });

            return {
              voterId: player.id,
              voterSeatNo: player.seatNo!,
              targetSeatNo: toolResult.targetSeatNo,
            };
          }
        } else {
          gameLogger.warn(
            `[PK投票] ${player.seatNo}号位 Agent 调用失败。原因: ${result.error || 'success=false 或 result 为空'}`,
          );
        }
      } catch (error) {
        gameLogger.error(
          `[PK投票] ${player.seatNo}号位投票出错: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      return null;
    });

    // 等待所有投票完成
    const voteResults = await Promise.all(votePromises);
    const votes = voteResults.filter(
      (v): v is { voterId: string; voterSeatNo: number; targetSeatNo: number } => v !== null,
    );

    // 降级策略：如果没有有效投票，随机从PK候选人中选一个
    if (votes.length === 0) {
      gameLogger.warn('[PK投票] 无有效投票，启用降级策略：随机选择一个PK候选人放逐');
      const randomSeatNo =
        state.pkCandidates[Math.floor(Math.random() * state.pkCandidates.length)];
      const exiledPlayer = state.players.find((p) => p.seatNo === randomSeatNo);

      return {
        exileTarget: exiledPlayer?.id || null,
        exileVoteCount: 0,
        pkCandidates: null,
        pkRound: 0,
      };
    }

    // 构建投票数据结构：targetId → voterIds[]
    const votesMap = new Map<string, string[]>();
    for (const vote of votes) {
      const target = state.players.find((p) => p.seatNo === vote.targetSeatNo);
      if (target) {
        if (!votesMap.has(target.id)) {
          votesMap.set(target.id, []);
        }
        votesMap.get(target.id)!.push(vote.voterId);
      }
    }

    // 二次降级：如果构建的投票数据为空（理论上不应发生）
    if (votesMap.size === 0) {
      gameLogger.warn('[PK投票] 投票数据为空，启用降级策略：随机选择一个PK候选人放逐');
      const randomSeatNo =
        state.pkCandidates[Math.floor(Math.random() * state.pkCandidates.length)];
      const exiledPlayer = state.players.find((p) => p.seatNo === randomSeatNo);

      return {
        exileTarget: exiledPlayer?.id || null,
        exileVoteCount: 0,
        pkCandidates: null,
        pkRound: 0,
      };
    }

    // 获取警长 ID
    const sheriff = state.players.find((p) => p.isSheriff && p.isAlive);
    const sheriffId = sheriff?.id;

    // 调用规则引擎统计票数
    const result = resolveVotes(votesMap, state.players, sheriffId);

    // 构建座位号 → 得票数的映射（用于日志）
    const voteCountBySeat = new Map<number, number>();
    for (const [playerId, voterIds] of votesMap.entries()) {
      const player = state.players.find((p) => p.id === playerId);
      if (player) {
        // 计算实际票数（考虑警长权重）
        const count = voterIds.reduce((sum, voterId) => {
          return sum + (sheriffId && voterId === sheriffId ? 1.5 : 1.0);
        }, 0);
        voteCountBySeat.set(player.seatNo, count);
      }
    }

    gameLogger.debug(
      `[PK投票] 得票统计: ${Array.from(voteCountBySeat.entries())
        .map(([seat, count]) => `${seat}号位(${count}票)`)
        .join(', ')}`,
    );

    // 再次平票 → 无人放逐
    if (result.isTie) {
      const tiedSeatNos = result.tiedPlayerIds
        .map((id) => state.players.find((p) => p.id === id)?.seatNo)
        .filter((seatNo): seatNo is number => seatNo !== undefined);

      gameLogger.debug(`[PK投票] PK再次平票: ${tiedSeatNos.join(', ')}号位，无人被放逐`);
      return {
        exileTarget: null,
        exileVoteCount: voteCountBySeat.size > 0 ? Math.max(...voteCountBySeat.values()) : 0,
        pkCandidates: null,
        pkRound: 0,
      };
    }

    // 唯一得票最高者，放逐
    const exiledPlayer = state.players.find((p) => p.id === result.executedPlayerId);

    if (exiledPlayer) {
      gameLogger.debug(`[PK投票] 放逐目标: ${exiledPlayer.seatNo}号位 (${exiledPlayer.id})`);
      return {
        exileTarget: exiledPlayer.id,
        exileVoteCount: voteCountBySeat.get(exiledPlayer.seatNo) || 0,
        pkCandidates: null,
        pkRound: 0,
      };
    }

    gameLogger.warn('[PK投票] 未找到放逐目标，跳过');
    return {
      exileTarget: null,
      pkCandidates: null,
      pkRound: 0,
    };
  };
};
