import { Injectable } from '@nestjs/common';
import { ACTION_TYPES } from '@ai-werewolf/shared';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import { ModelCallError } from '@/llm/model-call-guard';
import {
  VoteTurnBindingError,
  type CommittedVoteEvent,
  type VoteAction,
  type VoteTurnCandidate,
  type VoteTurnPort,
  type VoteTurnReference,
  type VoteTurnRequest,
} from '@/game-engine/ports/vote-turn.port';

/** 应用侧持有的回合句柄：节点拿不到它的类型，只能原样回传。 */
type TurnHandle = Parameters<AgentRuntimeService['recordExperienceUsages']>[0];

type RawVoteDecision = { action: 'cast_vote' | 'abstain'; targetSeatNo?: number };

/**
 * 普通投票的游戏侧端口实现。
 *
 * 应用侧负责准备授权输入、生成候选，并在行为事件提交后确认本人历史与归因；
 * 领域动作只作为返回值交给节点，事件写入、结算和发布仍由节点用现有组件完成。
 */
@Injectable()
export class VoteTurnAdapter implements VoteTurnPort {
  /** 上下文只按引用对象索引，节点无法从返回值里读到它。 */
  private readonly handles = new WeakMap<VoteTurnReference, TurnHandle>();

  constructor(private readonly agentRuntime: AgentRuntimeService) {}

  async vote(request: VoteTurnRequest): Promise<VoteTurnCandidate> {
    const handle = await this.agentRuntime.prepareContextPublic({
      phaseInstanceId: request.phaseInstanceId,
      gameId: request.gameId,
      playerId: request.playerId,
      scenario: 'vote',
      actionType: 'vote',
      position: {
        day: request.day,
        phase: request.phase,
        round: request.round,
        aliveSeats: request.aliveSeatNos,
      },
      additionalContext: `你只能投票给以下存活玩家之一：${request.legalSeatNos.join('号、')}号，或弃权。`,
    });
    const { reasoning, decision } = await this.agentRuntime.decide<RawVoteDecision>(
      handle,
      request.schema,
      request.signal,
    );
    let action: VoteAction;
    if (decision.action === 'cast_vote') {
      // 契约允许 cast_vote 不带目标；缺目标属非法输出，沿用原有降级分类。
      if (typeof decision.targetSeatNo !== 'number') throw new ModelCallError('invalid_output');
      action = { action: 'cast_vote', targetSeatNo: decision.targetSeatNo };
    } else {
      action = { action: 'abstain' };
    }
    const reference: VoteTurnReference = {
      gameId: request.gameId,
      playerId: request.playerId,
      seatNo: request.seatNo,
      day: request.day,
      round: request.round,
      action,
    };
    this.handles.set(reference, handle);
    return { reference, reasoning, source: handle.source };
  }

  async confirm(reference: VoteTurnReference, event: CommittedVoteEvent): Promise<void> {
    const handle = this.handles.get(reference);
    if (!handle)
      throw new VoteTurnBindingError(
        `引用不属于本次执行的投票回合：${reference.gameId}/${reference.playerId}/${reference.day}`,
      );
    assertVoteEventMatches(reference, event);
    await this.agentRuntime.recordExperienceUsages(handle, event);
  }
}

/**
 * 事件必须属于本次请求的局、玩家、日次、轮次和目标，否则不能写入本人记录。
 *
 * 阶段与动作类型由写入方按投票固定，不构成第二个可错绑的自由度。
 * 核对发生在整批事件已经提交之后：不一致只可能来自代码缺陷，此时宁可让本批作废也不能
 * 把别人的记录写成本人的；这条路径没有「提交前就发现」的替代方案，因为核对对象就是
 * 实际落库的事件。
 */
export function assertVoteEventMatches(
  reference: VoteTurnReference,
  event: CommittedVoteEvent,
): void {
  const content = (event.content ?? {}) as Record<string, unknown>;
  const expectedTarget =
    reference.action.action === 'cast_vote' ? reference.action.targetSeatNo : 0;
  const voteRound = content.voteRound ?? 0;
  const matched =
    event.actionType === ACTION_TYPES.VOTE &&
    event.gameId === reference.gameId &&
    event.actorId === reference.playerId &&
    event.day === reference.day &&
    voteRound === reference.round &&
    content.voterSeatNo === reference.seatNo &&
    content.targetSeatNo === expectedTarget;
  if (!matched)
    throw new VoteTurnBindingError(
      `投票事件与本次请求不符：${event.gameId}/${event.actorId}/${event.day}/第${String(voteRound)}轮/${String(content.voterSeatNo)}号→${String(content.targetSeatNo)}`,
    );
}
