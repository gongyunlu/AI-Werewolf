import { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { ACTION_TYPES as A } from '@ai-werewolf/shared';
import type { Event } from '@/generated/prisma/client';
import { GameFailurePolicy } from '../core/game-failure-policy';
import { createMockGame, type MockGame } from './mock-game-harness';
import type { ModelRequest } from './scripted-game-model';

jest.mock('@langchain/openai', () => ({ ChatOpenAI: jest.fn() }));

const content = (event: Event) => event.content as Record<string, unknown>;
const unavailable = () => Object.assign(new Error('mock provider unavailable'), { status: 503 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('标准六人 mock 完整对局', () => {
  let game: MockGame | undefined;
  let fallback: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date('2026-09-08T08:00:00Z'),
      doNotFake: ['nextTick', 'setImmediate'],
    });
    let seed = 42;
    jest.spyOn(Math, 'random').mockImplementation(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('mock 对局禁止网络访问'));
    fallback = jest.spyOn(GameFailurePolicy.prototype, 'consume');
  });

  afterEach(async () => {
    if (game) {
      const events = game.store.events;
      expect(events.filter((e) => e.actionType === A.GAME_STARTED)).toHaveLength(1);
      expect(new Set(events.map((e) => e.sequence)).size).toBe(events.length);
      const actions = events.filter((e) =>
        [A.VOTE, A.SEER_CHECK, A.WITCH_SAVE, A.WITCH_POISON, A.WOLF_KILL].includes(
          e.actionType as never,
        ),
      );
      const keys = actions.map((e) =>
        [e.day, e.actionType, e.actorId, content(e).voteRound ?? 0].join('/'),
      );
      expect(new Set(keys).size).toBe(actions.length);
      const medicines = events.filter(
        (e) =>
          (e.actionType === A.WITCH_SAVE && content(e).saved) ||
          (e.actionType === A.WITCH_POISON && content(e).used),
      );
      expect(new Set(medicines.map((e) => `${e.day}/${e.actorId}`)).size).toBe(medicines.length);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      await game.close();
      game = undefined;
    }
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('启用反思后完整对局仍只提交最终动作，快照包含质量记录', async () => {
    game = await createMockGame('villager', { TURN_REFLECTION_MAX_ROUNDS: 3 });
    await assertFinished('villager');
    const snapshots = [...game.store.snapshots.values()];
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.some((s: any) => (s.snapshot ?? s).reflection?.status === 'passed')).toBe(
      true,
    );
  });

  async function assertFinished(winner: string) {
    await game!.run();
    expect(game!.store.game).toMatchObject({
      status: 'finished',
      winnerFaction: winner,
      totalDays: 2,
    });
    expect(game!.store.events.filter((e) => e.actionType === A.GAME_ENDED)).toHaveLength(1);
    const state = await game!.execution.mock.results[0].value;
    expect(state).toMatchObject({ isGameOver: true, winner });
    for (const player of state.players) {
      expect(game!.store.players.find((p) => p.id === player.id)?.deathDay).toBe(player.deathDay);
    }
    const resolutions = game!.store.events.filter((e) => e.actionType === 'night_resolved');
    expect(resolutions.map((e) => e.day)).toEqual([1, 2]);
    expect(resolutions.every((e) => e.visibility === 'system')).toBe(true);
    const lastNight = resolutions[1];
    expect(lastNight.sequence).toBeLessThan(
      game!.store.events.find((e) => e.actionType === A.GAME_ENDED)!.sequence,
    );
    for (const death of content(lastNight).deaths as Array<{ playerId: string; cause: string }>) {
      expect(game!.store.players.find((p) => p.id === death.playerId)).toMatchObject({
        deathDay: 2,
        deathCause: death.cause,
      });
    }
    expect(game!.analysis.analyzeGame).toHaveBeenCalledTimes(1);
    expect(game!.store.events.some((e) => e.actionType === A.VOTE)).toBe(true);
    expect(
      game!.store.events.some((e) => e.actionType === A.SPEECH && e.visibility === 'public'),
    ).toBe(true);
    expect(game!.store.snapshots.size).toBeGreaterThan(0);
    const firstSnapshot = [...game!.store.snapshots.values()][0] as any;
    expect(
      (firstSnapshot.snapshot ?? firstSnapshot).prompts['game/wolf-coordination'],
    ).toBeDefined();
    for (const request of game!.model.requests.filter((r) => r.kind !== 'coordination')) {
      const prompt = String((request.messages as Array<{ content: unknown }>)[0].content);
      expect(prompt).toContain('绑票不是终局');
      expect(prompt).toContain(`座位号：${request.seat}`);
    }
  }

  async function assertAborted(result: Promise<unknown> = game!.run()) {
    await expect(result).rejects.toBeInstanceOf(UnrecoverableError);
    expect(game!.store.game).toMatchObject({ status: 'aborted', winnerFaction: null });
    expect(game!.store.events.some((e) => e.actionType === A.GAME_ENDED)).toBe(false);
    expect(game!.analysis.analyzeGame).not.toHaveBeenCalled();
    const eventCount = game!.store.events.length;
    const current = game!;
    await current.worker.process({ ...current.job, attemptsMade: 1 } as typeof current.job);
    expect(game!.execution).toHaveBeenCalledTimes(1);
    expect(game!.store.events).toHaveLength(eventCount);
  }

  it('01 好人获胜：首夜救人、白天放逐、次夜毒杀，正常终局', async () => {
    game = await createMockGame();
    await assertFinished('villager');
    expect(fallback).not.toHaveBeenCalled();
    expect(
      game.store.events.filter((e) => e.actionType === A.WITCH_SAVE && content(e).saved),
    ).toHaveLength(1);
    expect(
      game.store.events.filter((e) => e.actionType === A.WITCH_POISON && content(e).used),
    ).toHaveLength(1);
  });

  it('02 狼人获胜：绑票后继续第二夜，平民全灭才结束', async () => {
    game = await createMockGame('werewolf');
    await assertFinished('werewolf');
    expect(fallback).not.toHaveBeenCalled();
    expect(game.store.events.filter((e) => e.actionType === A.WOLF_KILL).map((e) => e.day)).toEqual(
      [1, 2],
    );
    expect(
      game.store.players.filter((p) => p.role === 'villager').every((p) => p.deathDay !== null),
    ).toBe(true);
  });

  it('03 查验模型超时取消，单次重试成功后正常完局', async () => {
    game = await createMockGame();
    const arrived = deferred<ModelRequest>();
    const late = deferred<void>();
    let failures = 0;
    game.model.beforeRequest = async (r) => {
      if (r.action === 'check_identity' && failures++ === 0) {
        arrived.resolve(r);
        await late.promise;
      }
    };
    const finished = assertFinished('villager');
    const request = await arrived.promise;
    await jest.advanceTimersByTimeAsync(1001);
    late.resolve();
    await finished;
    expect(request.signal.aborted).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
    expect(
      game.model.requests.filter((r) => r.day === 1 && r.action === 'check_identity'),
    ).toHaveLength(2);
  });

  it('04 熔断后同一路由不再调用供应商，额度耗尽停止游戏', async () => {
    game = await createMockGame('villager', {
      LLM_CIRCUIT_MIN_SAMPLES: 1,
      GAME_MAX_MODEL_FALLBACKS: 1,
    });
    game.model.beforeRequest = (r) => {
      if (r.seat === 3) throw unavailable();
    };
    await assertAborted();
    expect(game.model.requests.filter((r) => r.seat === 3)).toHaveLength(1);
    expect(fallback.mock.calls.some(([error]) => error.code === 'circuit_open')).toBe(true);
  });

  it('05 连续模型故障达到每局降级预算，不由替代行动打完整局', async () => {
    game = await createMockGame();
    game.model.beforeRequest = (r) => {
      if (r.seat === 3) throw unavailable();
    };
    await assertAborted();
    expect(fallback.mock.results.map((r) => r.type)).toEqual(['return', 'return', 'throw']);
    expect(game.store.events.filter((e) => e.actionType === A.SEER_CHECK)).toHaveLength(1);
    expect(game.store.events.some((e) => e.actionType === A.VOTE && e.actorId === 'player-3')).toBe(
      false,
    );
  });

  it('06 用户取消正在等待的查验，晚到响应不能提交行动', async () => {
    game = await createMockGame();
    const arrived = deferred<ModelRequest>();
    const late = deferred<void>();
    game.model.beforeRequest = async (r) => {
      if (r.action === 'check_identity') {
        arrived.resolve(r);
        await late.promise;
      }
    };
    const result = game.run();
    const outcome = assertAborted(result);
    const request = await arrived.promise;
    expect(game.executor.abortGame(game.store.gameId)).toBe(true);
    await outcome;
    expect(request.signal.aborted).toBe(true);
    late.resolve();
    await jest.advanceTimersByTimeAsync(1);
    expect(game.store.events.some((e) => e.actionType === A.SEER_CHECK)).toBe(false);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('07 对局达到运行预算停止，不伪造胜者', async () => {
    game = await createMockGame('villager', { GAME_MAX_DAYS: 1 });
    await assertAborted();
    expect(game.store.events.filter((e) => e.actionType === A.WOLF_KILL).map((e) => e.day)).toEqual(
      [1],
    );
    expect(game.store.events.some((e) => e.actionType === A.PLAYER_EXECUTED)).toBe(true);
  });

  it.each(['commit', 'usage', 'publish'] as const)(
    '提交后的 %s 故障保留原查验，终止后不重放',
    async (fault) => {
      game = await createMockGame();
      const error = new Error(`injected ${fault} failure`);
      if (fault === 'commit')
        game.store.afterEventCreated = (event) => {
          if (event.actionType === A.SEER_CHECK) throw error;
        };
      if (fault === 'usage')
        game.memory.recordUsages.mockImplementation(async (usages) => {
          if (
            usages.some(
              (u) =>
                game!.store.events.find((e) => e.id === u.eventId)?.actionType === A.SEER_CHECK,
            )
          )
            throw error;
        });
      if (fault === 'publish')
        game.bus.publish.mockImplementation(async (event) => {
          if (event.actionType === A.SEER_CHECK) throw error;
          game!.published.push(event);
        });
      await assertAborted();
      const checks = game.store.events.filter((e) => e.actionType === A.SEER_CHECK);
      expect(checks).toHaveLength(1);
      expect(content(checks[0])).toMatchObject({ targetSeatNo: 1, result: 'werewolf' });
      expect(game.model.requests.filter((r) => r.action === 'check_identity')).toHaveLength(1);
      expect(game.store.players.every((p) => p.deathDay === null)).toBe(true);
      expect(fallback).not.toHaveBeenCalled();
      expect(game.published.some((e) => e.id === checks[0].id)).toBe(false);
    },
  );
});
