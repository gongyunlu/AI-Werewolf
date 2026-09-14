import type { z } from 'zod';

/** 普通投票的领域动作；只有游戏规则决定取值。 */
export type VoteAction = { action: 'cast_vote'; targetSeatNo: number } | { action: 'abstain' };

export interface VoteTurnRequest {
  gameId: string;
  playerId: string;
  seatNo: number;
  day: number;
  /** 引擎给出的阶段标签，player-turn 不再自行推断。 */
  phase: string;
  round: number;
  aliveSeatNos: number[];
  /** 合法目标由游戏侧计算，player-turn 不重新推导第二套值。 */
  legalSeatNos: number[];
  /** 游戏生成的动作契约；player-turn 只校验和收窄，不重新定义合法目标。 */
  schema: z.ZodType<{ action: 'cast_vote' | 'abstain'; targetSeatNo?: number }>;
  signal?: AbortSignal;
}

/**
 * 仅在本代执行内有效的私有回合引用。
 *
 * 它绑定本次请求与最终动作，供应用侧在事件提交后确认历史与归因；不写库、不冒充持久
 * turnId，恢复时按原输入重新生成，因此不能跨执行代次传递或作长期缓存。
 *
 * 引用本身只有领域动作和绑定字段：应用侧的上下文句柄不放在这里，节点拿不到。
 * 原样回传同一个对象即可确认，复制或改写后的引用无法通过确认。
 */
export interface VoteTurnReference {
  readonly gameId: string;
  readonly playerId: string;
  readonly seatNo: number;
  readonly day: number;
  readonly round: number;
  readonly action: VoteAction;
}

/** 一次投票候选：引用与它的形成理由分开返回，节点拿不到应用侧的上下文句柄。 */
export interface VoteTurnCandidate {
  /** 原样回传，用于事件提交后确认本人历史与归因 */
  reference: VoteTurnReference;
  /** 该候选的形成理由，随投票事件落库并在观战页展示 */
  reasoning: string;
}

export interface CommittedVoteEvent {
  id: string;
  gameId: string;
  actionType: string;
  actorId: string | null;
  day: number | null;
  content: unknown;
}

/** 事件与本次请求不符：属于绑定错误，不能降级成第二张弃票。 */
export class VoteTurnBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoteTurnBindingError';
  }
}

export const VOTE_TURN_PORT = Symbol('VOTE_TURN_PORT');

export interface VoteTurnPort {
  /** 生成一次普通投票候选；模型与协议失败沿用线上回合原有的错误分类。 */
  vote(request: VoteTurnRequest): Promise<VoteTurnCandidate>;
  /** 行为 Event 提交后确认本人历史与归因；事件与请求不符时抛绑定错误。 */
  confirm(reference: VoteTurnReference, event: CommittedVoteEvent): Promise<void>;
}
