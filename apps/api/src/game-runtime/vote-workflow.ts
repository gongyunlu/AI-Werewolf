import { Annotation, END, START, StateGraph, task } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { PreparedTurnInput } from '../agent-runtime/agent-runtime.service';
import { settleGameActions } from '../game-engine/core/game-failure-policy';
import type { VoteTurnCandidate } from '../game-engine/ports/vote-turn.port';

/** 一名投票者的冻结输入：整轮开始时的视图，不随后续事件变化。 */
export interface VoteRoundVoter {
  playerId: string;
  seatNo: number;
  aliveSeatNos: number[];
  legalSeatNos: number[];
}

/** 冻结快照：恢复时由检查点还原，必须与首次进入时逐字一致。 */
export interface VoteRoundInput {
  gameId: string;
  phaseInstanceId: string;
  day: number;
  /**
   * 进入整轮时冻结的事件水位。
   *
   * 恢复时以检查点里的值为准：重算会把崩溃前已提交的票算进恢复后分支的视图。
   */
  visibleThrough: number;
  voters: VoteRoundVoter[];
}

/**
 * 普通投票的一轮：并行收齐全部候选后一次提交。
 *
 * 准备节点与生成节点分开，sync 持久化在发请求前提交全部私有输入及来源。
 * 候选生成作为持久任务，提交节点重入由领域批次幂等去重。
 *
 * 候选生成的调用顺序必须只由冻结输入决定：任务身份按调用位置派生，顺序变化会把
 * 上一轮的产出错配给别的投票者。
 */
export function createVoteRound<Commit>(options: {
  checkpointer: BaseCheckpointSaver;
  signal: AbortSignal;
  prepare: (input: VoteRoundInput) => Promise<PreparedTurnInput[]>;
  generate: (
    input: VoteRoundInput,
    voter: VoteRoundVoter,
    prepared: PreparedTurnInput,
    signal: AbortSignal,
  ) => Promise<VoteTurnCandidate>;
  commit: (
    input: VoteRoundInput,
    candidates: VoteTurnCandidate[],
    signal: AbortSignal,
  ) => Promise<Commit>;
}) {
  // 任务体拿到的是恢复后的冻结输入，视图与该分支首次执行时一致。
  const vote = task(
    'vote',
    (input: VoteRoundInput, voter: VoteRoundVoter, prepared: PreparedTurnInput) =>
      options.generate(input, voter, prepared, options.signal),
  );
  const State = Annotation.Root({
    input: Annotation<VoteRoundInput>,
    prepared: Annotation<PreparedTurnInput[]>,
    candidates: Annotation<VoteTurnCandidate[]>,
    committed: Annotation<Commit>,
  });
  return new StateGraph(State)
    .addNode('prepare', async ({ input }) => ({ prepared: await options.prepare(input) }))
    .addNode('generate', async ({ input, prepared }) => ({
      candidates: await settleGameActions(
        input.voters.map(async (voter, index) => {
          const frozen = prepared[index];
          if (!frozen || frozen.player.id !== voter.playerId)
            throw new Error('投票者与冻结输入不一致');
          return await vote(input, voter, frozen);
        }),
      ),
    }))
    .addNode('commit', async ({ input, candidates }) => ({
      committed: await options.commit(input, candidates, options.signal),
    }))
    .addEdge(START, 'prepare')
    .addEdge('prepare', 'generate')
    .addEdge('generate', 'commit')
    .addEdge('commit', END)
    .compile({ checkpointer: options.checkpointer });
}
