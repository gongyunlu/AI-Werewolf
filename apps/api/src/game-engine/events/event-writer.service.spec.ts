import { ACTION_TYPES } from '@ai-werewolf/shared';
import type { PrismaService } from '../../prisma/prisma.service';
import { EventWriterService } from './event-writer.service';
import { MockGameStore } from '../testing/mock-game-store';
import { normalizeSubmission, submissionHash } from './submission-protocol';

function setup() {
  const store = new MockGameStore();
  const writer = new EventWriterService(store.prisma as unknown as PrismaService);
  const scope = { gameId: store.gameId, phaseInstanceId: 'node/7/vote', day: 1 };
  const input = {
    ...scope,
    expectedActorIds: ['player-1', 'player-2'],
    votes: [
      { actorId: 'player-2', voterSeatNo: 2, targetSeatNo: 0 },
      { actorId: 'player-1', voterSeatNo: 1, targetSeatNo: 2 },
    ],
  };
  return { store, writer, scope, input };
}

describe('领域提交规范化', () => {
  it('对象字段顺序和 undefined 缺省等价，null 与缺省不同', () => {
    expect(submissionHash({ b: 2, a: 1, c: undefined })).toBe(submissionHash({ a: 1, b: 2 }));
    expect(submissionHash({ a: null })).not.toBe(submissionHash({}));
  });
  it('保留一般数组的顺序，不把发言顺序当集合', () => {
    expect(submissionHash({ speechOrder: [1, 2] })).not.toBe(
      submissionHash({ speechOrder: [2, 1] }),
    );
  });
  it.each([NaN, Infinity, new Date(), [undefined]])('拒绝非 JSON 输入：%s', (value) => {
    expect(() => normalizeSubmission(value)).toThrow();
  });
});

describe('EventWriterService 提交与状态边界', () => {
  it('整批在同一事务写入，按玩家稳定排序，弃票也是事件', async () => {
    const { store, writer, input } = setup();
    const transaction = jest.spyOn(store.prisma, '$transaction');
    const events = await writer.writeVoteBatch(input);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.actorId)).toEqual(['player-1', 'player-2']);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events[1].content).toEqual({ voteRound: 0, voterSeatNo: 2, targetSeatNo: 0 });
    expect(store.batches.size).toBe(1);
  });

  it('批内第二条写入失败时事件和批次记录一起回滚', async () => {
    const { store, writer, input } = setup();
    store.afterEventCreated = (event) => {
      if (event.sequence === 2) throw new Error('第二项写入失败');
    };
    await expect(writer.writeVoteBatch(input)).rejects.toThrow('第二项写入失败');
    expect(store.events).toHaveLength(0);
    expect(store.batches.size).toBe(0);
  });

  it('批次顺序与缺省 voteRound 不影响重试，内容变化报冲突', async () => {
    const { writer, input, store } = setup();
    const first = await writer.writeVoteBatch(input);
    const retry = await writer.writeVoteBatch({
      ...input,
      expectedActorIds: input.expectedActorIds.toReversed(),
      votes: input.votes.toReversed().map((vote) => ({ ...vote, voteRound: 0 })),
    });
    expect(retry.map((event) => event.id)).toEqual(first.map((event) => event.id));
    expect(retry.every((event) => event.replayed)).toBe(true);
    await expect(
      writer.writeVoteBatch({
        ...input,
        votes: input.votes.map((vote) => ({ ...vote, targetSeatNo: 3 })),
      }),
    ).rejects.toThrow('冲突');
    expect(store.events).toHaveLength(2);
  });

  it('空批次也提交完成记录，重复提交不新增批次也不写事件', async () => {
    const { writer, scope, store } = setup();
    const input = { ...scope, expectedActorIds: [], votes: [] };
    expect(await writer.writeVoteBatch(input)).toEqual([]);
    expect(await writer.writeVoteBatch(input)).toEqual([]);
    expect(store.batches.size).toBe(1);
    expect(store.events).toHaveLength(0);
  });

  it('自爆播报与明确死亡事实同事务，死亡失败时播报回滚', async () => {
    const { writer, scope, store } = setup();
    store.prisma.player.update.mockRejectedValueOnce(new Error('死亡写入失败'));
    await expect(
      writer.writeJudgeEvent({
        ...scope,
        content: '1号自爆',
        death: { playerId: 'player-1', cause: 'self_destruct' },
      }),
    ).rejects.toThrow('死亡写入失败');
    expect(store.events).toHaveLength(0);
    const event = await writer.writeJudgeEvent({
      ...scope,
      content: '1号自爆',
      death: { playerId: 'player-1', cause: 'self_destruct' },
    });
    expect(event.actionType).toBe(ACTION_TYPES.JUDGE_ANNOUNCE);
    expect(store.players[0].deathCause).toBe('self_destruct');
    await expect(
      writer.writeJudgeEvent({
        ...scope,
        content: '1号自爆',
        death: { playerId: 'player-2', cause: 'self_destruct' },
      }),
    ).rejects.toThrow('冲突');
    expect(store.players[1].deathDay).toBeNull();
  });

  it('终局事件与状态同事务，重试保留首次结束时间并比较状态内容', async () => {
    const { writer, scope, store } = setup();
    const input = { ...scope, winner: 'werewolf', winnerFaction: 'werewolf', totalDays: 3 };
    const first = await writer.writeGameEndEvent(input);
    const endedAt = store.game.endedAt;
    const retry = await writer.writeGameEndEvent(input);
    expect(retry.id).toBe(first.id);
    expect(store.game.status).toBe('finished');
    expect(store.game.endedAt).toEqual(endedAt);
    await expect(writer.writeGameEndEvent({ ...input, totalDays: 4 })).rejects.toThrow('冲突');
    expect(store.game.totalDays).toBe(3);
  });
});
