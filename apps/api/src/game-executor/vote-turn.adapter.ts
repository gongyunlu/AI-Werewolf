import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AgentRuntimeService, type PreparedTurnInput } from '@/agent-runtime/agent-runtime.service';
import type { ModelStageStore } from '@/llm/model-stage';
import type { TurnContextRequest } from '@/agent-runtime/turn-context';
import { ModelCallError } from '@/llm/model-call-guard';
import { legalVoteActions, type VoteAction } from '@/game-engine/rules/ordinary-vote';
import type {
  VoteTurnCandidate,
  VoteTurnPort,
  VoteTurnRequest,
} from '@/game-engine/ports/vote-turn.port';

/** Schema 从领域合法动作生成，不另行维护目标与弃票规则。 */
export function buildVoteSchema(legalSeatNos: number[]) {
  return z.union(
    legalVoteActions(legalSeatNos).map((action) =>
      action.action === 'cast_vote'
        ? z.object({
            action: z.literal(action.action),
            targetSeatNo: z.literal(action.targetSeatNo),
          })
        : z.object({ action: z.literal(action.action) }),
    ),
  );
}

@Injectable()
export class VoteTurnAdapter implements VoteTurnPort {
  constructor(private readonly agentRuntime: AgentRuntimeService) {}

  visibleThrough(gameId: string): Promise<number> {
    return this.agentRuntime.voteVisibleThrough(gameId);
  }

  prepare(request: VoteTurnRequest): Promise<PreparedTurnInput> {
    return this.agentRuntime.prepareTurnInput(this.contextRequest(request));
  }

  private contextRequest(request: VoteTurnRequest): TurnContextRequest {
    return {
      phaseInstanceId: request.phaseInstanceId,
      gameId: request.gameId,
      playerId: request.playerId,
      scenario: 'vote',
      actionType: 'vote',
      visibleThrough: request.visibleThrough,
      position: {
        day: request.day,
        phase: request.phase,
        round: request.round,
        aliveSeats: request.aliveSeatNos,
      },
      additionalContext: `你只能投票给以下存活玩家之一：${request.legalSeatNos.join('号、')}号，或弃权。`,
    };
  }

  async vote(
    request: VoteTurnRequest,
    execution?: { prepared: PreparedTurnInput; stages: ModelStageStore },
  ): Promise<VoteTurnCandidate> {
    // 图状态不能被生成器的观测引用和决策快照更新原地修改。
    const context = execution
      ? structuredClone(execution.prepared)
      : await this.agentRuntime.prepareContextPublic(this.contextRequest(request));
    const schema = buildVoteSchema(request.legalSeatNos);
    const { reasoning, decision } = execution
      ? await this.agentRuntime.decidePrepared<VoteAction>(
          context as PreparedTurnInput,
          schema,
          execution.stages,
          request.signal,
        )
      : await this.agentRuntime.decide<VoteAction>(
          context as Awaited<ReturnType<AgentRuntimeService['prepareContextPublic']>>,
          schema,
          request.signal,
        );
    const parsed = schema.safeParse(decision);
    if (!parsed.success) throw new ModelCallError('invalid_output');
    if (!context.source || !context.replay) throw new Error('普通投票缺少采用来源或决策快照');
    // 只把明确摘取的 JSON 数据交给提交器。
    return JSON.parse(
      JSON.stringify({
        reference: {
          gameId: request.gameId,
          phaseInstanceId: request.phaseInstanceId,
          playerId: request.playerId,
          seatNo: request.seatNo,
          day: request.day,
          round: request.round,
          visibleThrough: request.visibleThrough,
          action: parsed.data,
        },
        reasoning,
        source: context.source,
        attribution: {
          snapshot: context.replay,
          memoryUsages: context.pendingMemoryUsages,
          knowledgeUsages: context.pendingKnowledgeUsages,
          retrievalId: context.retrievalId,
          experiment: Boolean(context.experiment),
        },
      }),
    ) as VoteTurnCandidate;
  }
}
