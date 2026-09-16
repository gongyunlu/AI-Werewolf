import type { ActionSource } from '@/observability/action-source';
import type { VoteAction } from '../rules/ordinary-vote';

export interface VoteTurnRequest {
  phaseInstanceId: string;
  gameId: string;
  playerId: string;
  seatNo: number;
  day: number;
  phase: string;
  round: number;
  aliveSeatNos: number[];
  legalSeatNos: number[];
  /** 整轮共用进入节点时的事件水位。 */
  visibleThrough: number;
  signal?: AbortSignal;
}

/** 核心校验和计票只消费行动及必要身份。 */
export interface VoteTurnReference {
  gameId: string;
  phaseInstanceId: string;
  playerId: string;
  seatNo: number;
  day: number;
  round: number;
  visibleThrough: number;
  action: VoteAction;
}

/** 只摘取提交所需资料；不得放入完整 AgentContext、凭据或运行时对象。 */
export interface VoteAttribution {
  snapshot: Record<string, unknown>;
  memoryUsages: Array<{ memoryId: string; triggerMatched: boolean }>;
  knowledgeUsages: Array<{ chunkId: string }>;
  retrievalId?: string;
  experiment: boolean;
}

/** 可跨进程传递的应用产物，节点只转交归因资料，不将其交给规则函数。 */
export interface VoteTurnCandidate {
  source: ActionSource;
  reference: VoteTurnReference;
  reasoning: string;
  attribution: VoteAttribution;
}

export interface CommittedVoteEvent {
  id: string;
  gameId: string;
  actionType: string;
  actorId: string | null;
  day: number | null;
  content: unknown;
}

export class VoteTurnBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoteTurnBindingError';
  }
}

export const VOTE_TURN_PORT = Symbol('VOTE_TURN_PORT');

export interface VoteTurnPort {
  visibleThrough(gameId: string): Promise<number>;
  vote(request: VoteTurnRequest): Promise<VoteTurnCandidate>;
}
