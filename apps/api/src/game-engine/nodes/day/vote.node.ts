import { ModelCallError } from '@/llm/model-call-guard';
import { failModelCall, settleGameActions } from '../../core/game-failure-policy';
import { Injectable } from '@nestjs/common';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory, NodeContext } from '../node.types';
import type { VoteTurnCandidate } from '../../ports/vote-turn.port';
import { isLegalVoteAction } from '../../rules/ordinary-vote';
import { resolveVotes } from '../../rules/vote-resolution';

interface CollectedVote {
  voter: GameGraphState['players'][0];
  targetId: string | null; // null 表示弃权
  targetSeatNo: number; // 0 表示弃权
  candidate: VoteTurnCandidate;
}

@Injectable()
export class VoteNode {
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
      const visibleThrough = await context.voteTurn.visibleThrough(state.gameId);

      // 先并行收齐全部候选：本轮投票在收齐后一次提交，批次内不写 Event。
      const collected = await settleGameActions(
        alivePlayers.map((voter) =>
          this.collectVote(voter, state, context, legalSeatNos, visibleThrough),
        ),
      );

      const events = await context.eventWriter.writeVoteBatch({
        phaseInstanceId: state.phaseInstanceId,
        signal: context.signal,
        gameId: state.gameId,
        day: state.currentDay,
        expectedActorIds: alivePlayers.map((player) => player.id),
        sources: Object.fromEntries(
          collected.map((vote) => [vote.voter.id, vote.candidate.source]),
        ),
        turns: collected.map((vote) => vote.candidate),
        votes: collected.map(({ voter, targetSeatNo, candidate }) => ({
          actorId: voter.id,
          voterSeatNo: voter.seatNo,
          targetSeatNo,
          thinking: candidate.reasoning,
        })),
      });
      for (const event of events) await context.eventBus?.publish(event);

      // 汇总为 resolveVotes 需要的结构：被投票人 ID → 投票人 ID[]
      const votes = new Map<string, string[]>();
      collected.forEach(({ voter, targetId }) => {
        if (targetId !== null) {
          const voters = votes.get(targetId) ?? [];
          voters.push(voter.id);
          votes.set(targetId, voters);
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

  /**
   * 生成单个玩家的投票候选。
   *
   * 这里只产生候选，不写任何 Event：整轮投票收齐后才一次提交。模型调用失败直接上抛，
   * 由批次整体失败而不是补一张弃票。
   */
  private async collectVote(
    voter: GameGraphState['players'][0],
    state: GameGraphState,
    context: NodeContext,
    legalSeatNos: number[],
    visibleThrough: number,
  ): Promise<CollectedVote> {
    try {
      const candidate = await context.voteTurn.vote({
        phaseInstanceId: state.phaseInstanceId,
        gameId: state.gameId,
        playerId: voter.id,
        seatNo: voter.seatNo,
        day: state.currentDay,
        phase: '普通投票',
        round: 0,
        aliveSeatNos: state.players.filter((p) => p.isAlive).map((p) => p.seatNo),
        legalSeatNos,
        visibleThrough,
        signal: context.signal,
      });

      const action = candidate.reference.action;
      if (!isLegalVoteAction(action, legalSeatNos)) throw new ModelCallError('invalid_output');
      if (action.action === 'abstain') return { voter, targetId: null, targetSeatNo: 0, candidate };

      const target = state.players.find((p) => p.seatNo === action.targetSeatNo);
      if (!target || !target.isAlive) throw new ModelCallError('invalid_output');
      return {
        voter,
        targetId: target.id,
        targetSeatNo: target.seatNo,
        candidate,
      };
    } catch (error) {
      failModelCall(error, context, `[投票阶段] ${voter.seatNo}号位投票出错`);
    }
  }
}
