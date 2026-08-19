import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { resolveVotes } from '../../rules/vote-resolution';
import { gameLogger } from '../../utils/game-logger';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';

function buildPkVoteSchema(legalSeatNos: number[]) {
  return z.object({
    targetSeatNo: z
      .number()
      .int()
      .describe(`投票目标的座位号（只能从PK候选中选择：${legalSeatNos.join('、')}号）`),
  });
}

type VoteDecision = {
  targetSeatNo: number;
};

/**
 * PK 投票节点（两阶段版本）
 */
@Injectable()
export class PkVoteNode {
  constructor(private readonly agentRuntime: AgentRuntimeService) {}

  create(): NodeFactory {
    return (context) => async (state: GameGraphState) => {
      if (!state.pkCandidates || state.pkCandidates.length === 0) {
        return {};
      }

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

      const votePromises = voters.map(async (player) => {
        try {
          const extraInfo = `这是PK投票，你只能投给以下候选人之一: ${state.pkCandidates!.join(', ')}号位。不能弃票。`;

          const contextData = await this.agentRuntime.prepareContextPublic(
            state.gameId,
            player.id,
            'vote' as any,
            extraInfo,
          );

          const threadId = getPlayerThreadId(state.gameId, player.id);

          // 阶段1：流式推理
          const reasoning = await this.agentRuntime.streamReasoning(
            contextData,
            threadId,
            undefined,
            (_token) => {
              // PK投票不推送推理过程
            },
          );

          // 阶段2：生成决策
          const decision = await this.agentRuntime.generateDecision<VoteDecision>(
            contextData,
            reasoning,
            buildPkVoteSchema(state.pkCandidates!),
            undefined,
            threadId,
          );

          // 验证投票目标是否在PK候选人中
          if (!state.pkCandidates!.includes(decision.targetSeatNo)) {
            gameLogger.warn(
              `[PK投票] ${player.seatNo}号位投票目标 ${decision.targetSeatNo} 不在PK候选人中，视为无效投票`,
            );
            return null;
          }

          const event = await context.eventWriter.writePlayerVoteEvent({
            gameId: state.gameId,
            day: state.currentDay,
            actorId: player.id,
            voterSeatNo: player.seatNo!,
            targetSeatNo: decision.targetSeatNo,
          });
          await context.eventBus?.publish(event);

          return {
            voterId: player.id,
            voterSeatNo: player.seatNo!,
            targetSeatNo: decision.targetSeatNo,
          };
        } catch (error) {
          gameLogger.error(
            `[PK投票] ${player.seatNo}号位投票出错: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      });

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

      const sheriff = state.players.find((p) => p.isSheriff && p.isAlive);
      const sheriffId = sheriff?.id;

      const result = resolveVotes(votesMap, state.players, sheriffId);

      const voteCountBySeat = new Map<number, number>();
      for (const [playerId, voterIds] of votesMap.entries()) {
        const player = state.players.find((p) => p.id === playerId);
        if (player) {
          const count = voterIds.reduce((sum, voterId) => {
            return sum + (sheriffId && voterId === sheriffId ? 1.5 : 1.0);
          }, 0);
          voteCountBySeat.set(player.seatNo, count);
        }
      }

      if (result.isTie) {
        return {
          exileTarget: null,
          exileVoteCount: voteCountBySeat.size > 0 ? Math.max(...voteCountBySeat.values()) : 0,
          pkCandidates: null,
          pkRound: 0,
        };
      }

      const exiledPlayer = state.players.find((p) => p.id === result.executedPlayerId);

      if (exiledPlayer) {
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
  }
}
