import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
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

  async vote(request: VoteTurnRequest): Promise<VoteTurnCandidate> {
    const context = await this.agentRuntime.prepareContextPublic({
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
    });
    const schema = buildVoteSchema(request.legalSeatNos);
    const { reasoning, decision } = await this.agentRuntime.decide<VoteAction>(
      context,
      schema,
      request.signal,
    );
    const parsed = schema.safeParse(decision);
    if (!parsed.success) throw new ModelCallError('invalid_output');
    if (!context.source || !context.replay) throw new Error('普通投票缺少采用来源或决策快照');
    // 继续复用原 context/decision 恢复键；只把明确摘取的 JSON 数据交给提交器。
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
