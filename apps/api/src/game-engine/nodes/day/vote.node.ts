import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory, NodeContext } from '../node.types';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { gameLogger } from '../../utils/game-logger';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import { resolveVotes } from '../../rules/vote-resolution';

function buildVoteSchema(legalSeatNos: number[]) {
  return z.object({
    action: z.enum(['cast_vote', 'abstain']),
    targetSeatNo: z
      .number()
      .int()
      .optional()
      .describe(`要投票的座位号（只能选：${legalSeatNos.join('、')}号；action=cast_vote 时必填）`),
  });
}

type VoteDecision =
  | {
      action: 'cast_vote';
      targetSeatNo: number;
    }
  | {
      action: 'abstain';
    };

interface VoteResult {
  voterId: string;
  targetId: string | null; // null 表示弃权
}

@Injectable()
export class VoteNode {
  constructor(private readonly agentRuntime: AgentRuntimeService) {}

  create(): NodeFactory {
    return (context) => async (state: GameGraphState) => {
      const { players } = state;
      const alivePlayers = players.filter((p) => p.isAlive);
      const sheriff = players.find((p) => p.isSheriff && p.isAlive);

      if (alivePlayers.length === 0) {
        return {};
      }

      // 合法投票目标 = 存活玩家（含自己）
      const legalSeatNos = alivePlayers.map((p) => p.seatNo);

      // 并行投票
      const votePromises = alivePlayers.map((voter) =>
        this.handleSingleVote(voter, state, context, legalSeatNos),
      );

      const voteResults = await Promise.all(votePromises);

      // 汇总为 resolveVotes 需要的结构：被投票人 ID → 投票人 ID[]
      const votes = new Map<string, string[]>();
      voteResults.forEach((result) => {
        if (result.targetId !== null) {
          const voters = votes.get(result.targetId) ?? [];
          voters.push(result.voterId);
          votes.set(result.targetId, voters);
        }
      });

      // 统一计票（内置警长 1.5 权重、投死人无效、死人投票无效）
      const resolution = resolveVotes(votes, players, sheriff?.id ?? null);

      // 计算被放逐者的得票数（供 player_executed 事件 voteCount 使用）
      const sheriffId = sheriff?.id ?? null;
      const voteCountBySeat = new Map<number, number>();
      for (const [playerId, voterIds] of votes.entries()) {
        const player = state.players.find((p) => p.id === playerId);
        if (player) {
          const count = voterIds.reduce((sum, voterId) => {
            return sum + (sheriffId && voterId === sheriffId ? 1.5 : 1.0);
          }, 0);
          voteCountBySeat.set(player.seatNo, count);
        }
      }

      if (resolution.executedPlayerId) {
        const executed = state.players.find((p) => p.id === resolution.executedPlayerId);
        return {
          exileTarget: resolution.executedPlayerId,
          exileVoteCount: executed ? voteCountBySeat.get(executed.seatNo) || 0 : 0,
        };
      } else if (resolution.isTie) {
        const pkSeatNos = resolution.tiedPlayerIds
          .map((id) => players.find((p) => p.id === id)?.seatNo)
          .filter((s): s is number => s !== undefined);
        return {
          pkCandidates: pkSeatNos,
        };
      } else {
        return {};
      }
    };
  }

  private async handleSingleVote(
    voter: GameGraphState['players'][0],
    state: GameGraphState,
    context: NodeContext,
    legalSeatNos: number[],
  ): Promise<VoteResult> {
    try {
      const contextData = await this.agentRuntime.prepareContextPublic(
        state.gameId,
        voter.id,
        'vote' as any,
        `你只能投票给以下存活玩家之一：${legalSeatNos.join('号、')}号，或弃权。`,
      );

      const threadId = getPlayerThreadId(state.gameId, voter.id);

      // 1. 推理
      const reasoning = await this.agentRuntime.streamReasoning(
        contextData,
        threadId,
        undefined,
        (_token) => {
          // 投票推理不对外广播
        },
      );

      // 2. 决策
      const decision = await this.agentRuntime.generateDecision<VoteDecision>(
        contextData,
        reasoning,
        buildVoteSchema(legalSeatNos),
        undefined,
        threadId,
      );

      if (decision.action === 'cast_vote') {
        const target = state.players.find((p) => p.seatNo === decision.targetSeatNo);
        if (!target || !target.isAlive) {
          const event = await context.eventWriter.writePlayerVoteEvent({
            gameId: state.gameId,
            day: state.currentDay,
            actorId: voter.id,
            voterSeatNo: voter.seatNo,
            targetSeatNo: 0,
          });
          await context.eventBus?.publish(event);
          return { voterId: voter.id, targetId: null };
        }

        const event = await context.eventWriter.writePlayerVoteEvent({
          gameId: state.gameId,
          day: state.currentDay,
          actorId: voter.id,
          voterSeatNo: voter.seatNo,
          targetSeatNo: decision.targetSeatNo,
        });
        await context.eventBus?.publish(event);

        return {
          voterId: voter.id,
          targetId: target.id,
        };
      } else {
        const event = await context.eventWriter.writePlayerVoteEvent({
          gameId: state.gameId,
          day: state.currentDay,
          actorId: voter.id,
          voterSeatNo: voter.seatNo,
          targetSeatNo: 0,
        });
        await context.eventBus?.publish(event);

        return {
          voterId: voter.id,
          targetId: null,
        };
      }
    } catch (error) {
      gameLogger.error(
        `[投票阶段] ${voter.seatNo}号位投票出错，降级为弃权: ${error instanceof Error ? error.message : String(error)}`,
      );

      return {
        voterId: voter.id,
        targetId: null,
      };
    }
  }
}
