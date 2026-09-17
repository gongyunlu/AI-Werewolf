import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventWriterService } from '../game-engine/events/event-writer.service';
import type { CommittedEvent } from '../game-engine/events/submission-protocol';
import type { VoteTurnCandidate, VoteTurnRequest } from '../game-engine/ports/vote-turn.port';
import type { GameExecution } from '../generated/prisma/client';
import { VoteTurnAdapter } from '../game-executor/vote-turn.adapter';
import { GameRecoveryService } from '../game-recovery/game-recovery.service';
import { settleGameActions } from '../game-engine/core/game-failure-policy';
import { createStageRecordStore } from '../game-recovery/stage-record-store';
import type { ExecutionIdentity } from '../game-recovery/execution-fence';
import { PrismaCheckpointSaver } from './prisma-checkpoint-saver';
import { createVoteRound, type VoteRoundInput, type VoteRoundVoter } from './vote-workflow';

export interface ResumeVoteRoundRequest {
  execution: GameExecution;
  phaseInstanceId: string;
  signal: AbortSignal;
  maxDurationMs?: number;
}

export interface VoteRoundRequest extends ResumeVoteRoundRequest {
  day: number;
  voters: VoteRoundVoter[];
}

/**
 * 普通投票的持久执行。
 *
 * 开始与恢复分开；两者都必须先领取整局执行权，恢复只接收工作身份。
 * 图承接流程进度，批次记录承接业务幂等，请求预算由模型阶段管理。
 */
@Injectable()
export class GameRuntimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventWriter: EventWriterService,
    private readonly voteTurn: VoteTurnAdapter,
    private readonly recovery: GameRecoveryService,
  ) {}

  async runVoteRound(request: VoteRoundRequest): Promise<CommittedEvent[]> {
    return this.run(request, request);
  }

  async resumeVoteRound(request: ResumeVoteRoundRequest): Promise<CommittedEvent[]> {
    return this.run(request);
  }

  private run(
    request: ResumeVoteRoundRequest,
    start?: VoteRoundRequest,
  ): Promise<CommittedEvent[]> {
    return this.recovery.run(
      request.execution,
      request.signal,
      async (signal) => {
        const scope = this.recovery.current!;
        signal.throwIfAborted();
        if (scope.manifest.version !== 2)
          throw new ConflictException('投票图需要带有请求预算的执行记录');
        return this.runClaimedVoteRound(
          request,
          {
            gameId: scope.execution.gameId,
            generation: scope.execution.generation,
            owner: scope.owner,
          },
          signal,
          start,
        );
      },
      request.maxDurationMs,
    );
  }

  private async runClaimedVoteRound(
    request: ResumeVoteRoundRequest,
    identity: ExecutionIdentity,
    signal: AbortSignal,
    start?: VoteRoundRequest,
  ): Promise<CommittedEvent[]> {
    const saver = new PrismaCheckpointSaver(this.prisma, identity, request.phaseInstanceId, signal);
    // 线程即对局，进度按构造时给定的节点实例分开存放；同步持久化保证落库后才返回。
    const config = {
      configurable: { thread_id: identity.gameId },
      durability: 'sync' as const,
      signal,
    };
    const existing = await saver.getTuple(config);
    if (start && existing) throw new ConflictException('投票阶段已有进度，请使用恢复入口');
    if (!start && !existing) throw new ConflictException('投票阶段没有可恢复的进度');
    const workflow = createVoteRound({
      checkpointer: saver,
      signal,
      prepare: (input) =>
        settleGameActions(
          input.voters.map((voter) =>
            this.voteTurn.prepare(this.turnRequest(input, voter, signal)),
          ),
        ),
      generate: (input, voter, prepared, branchSignal) =>
        this.voteTurn.vote(this.turnRequest(input, voter, branchSignal), {
          prepared,
          stages: createStageRecordStore({
            prisma: this.prisma,
            identity,
            prefix: `model-stage/${prepared.actionKey}`,
            signal,
          }),
        }),
      commit: (input, candidates, commitSignal) =>
        this.commit(identity, input, candidates, commitSignal),
    });
    const input: VoteRoundInput | null = start
      ? {
          gameId: identity.gameId,
          phaseInstanceId: request.phaseInstanceId,
          day: start.day,
          visibleThrough: await this.voteTurn.visibleThrough(identity.gameId),
          voters: structuredClone(start.voters),
        }
      : null;
    signal.throwIfAborted();
    const result = await workflow.invoke(input ? { input } : null, config);
    signal.throwIfAborted();
    return result.committed;
  }

  private turnRequest(
    input: VoteRoundInput,
    voter: VoteRoundVoter,
    signal: AbortSignal,
  ): VoteTurnRequest {
    return {
      phaseInstanceId: input.phaseInstanceId,
      gameId: input.gameId,
      playerId: voter.playerId,
      seatNo: voter.seatNo,
      day: input.day,
      phase: '普通投票',
      round: 0,
      aliveSeatNos: voter.aliveSeatNos,
      legalSeatNos: voter.legalSeatNos,
      visibleThrough: input.visibleThrough,
      signal,
    };
  }

  private commit(
    identity: ExecutionIdentity,
    input: VoteRoundInput,
    candidates: VoteTurnCandidate[],
    signal: AbortSignal,
  ): Promise<CommittedEvent[]> {
    return this.eventWriter.writeVoteBatch({
      gameId: input.gameId,
      phaseInstanceId: input.phaseInstanceId,
      execution: identity,
      signal,
      day: input.day,
      expectedActorIds: input.voters.map((voter) => voter.playerId),
      sources: Object.fromEntries(
        candidates.map((candidate) => [candidate.reference.playerId, candidate.source]),
      ),
      turns: candidates,
      votes: candidates.map((candidate) => ({
        actorId: candidate.reference.playerId,
        voterSeatNo: candidate.reference.seatNo,
        // 弃权在事件里记 0 号位，与投票节点保持同一约定。
        targetSeatNo:
          candidate.reference.action.action === 'abstain'
            ? 0
            : candidate.reference.action.targetSeatNo,
        thinking: candidate.reasoning,
      })),
    });
  }
}
