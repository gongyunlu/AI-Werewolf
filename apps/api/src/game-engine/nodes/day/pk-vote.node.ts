import { settleGameActions } from '../../core/game-failure-policy';
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
 * PK 投票节点（理由与动作一并生成）
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
        const extraInfo = `这是PK投票，你只能投给以下候选人之一: ${state.pkCandidates!.join(', ')}号位。不能弃票。`;

        const contextData = await this.agentRuntime.prepareContextPublic({
          gameId: state.gameId,
          playerId: player.id,
          scenario: 'vote',
          actionType: 'vote',
          position: {
            day: state.currentDay,
            phase: 'PK投票',
            round: Math.max(1, state.pkRound),
            aliveSeats: state.players.filter((p) => p.isAlive).map((p) => p.seatNo),
          },
          additionalContext: extraInfo,
        });

        const threadId = getPlayerThreadId(state.gameId, player.id);

        const { decision } = await this.agentRuntime.decide<VoteDecision>(
          contextData,
          buildPkVoteSchema(state.pkCandidates!),
          context.signal,
          threadId,
        );

        // 验证投票目标是否在PK候选人中
        if (!state.pkCandidates!.includes(decision.targetSeatNo)) {
          throw new Error('PK 投票目标非法，停止本批结算');
        }
        const event = await context.eventWriter.writePlayerVoteEvent({
          gameId: state.gameId,
          day: state.currentDay,
          actorId: player.id,
          voteRound: Math.max(1, state.pkRound),
          voterSeatNo: player.seatNo!,
          targetSeatNo: decision.targetSeatNo,
        });
        await this.agentRuntime.recordExperienceUsages(contextData, event);
        await context.eventBus?.publish(event);

        return {
          voterId: player.id,
          voterSeatNo: player.seatNo!,
          targetSeatNo: decision.targetSeatNo,
        };
      });

      const votes = await settleGameActions(votePromises);

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
        gameLogger.warn('[PK投票] 投票数据为空，停止对局');
        throw new Error('PK 投票结果无法关联目标，停止对局');
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
