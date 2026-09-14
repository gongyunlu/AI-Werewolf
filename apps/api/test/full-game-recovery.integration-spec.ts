import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ACTION_TYPES as A } from '@ai-werewolf/shared';
import type { Env } from '../src/config/env.validation';
import type { Event, Player } from '../src/generated/prisma/client';
import type { PrismaService } from '../src/prisma/prisma.service';
import { createMockGame, type MockGame } from '../src/game-engine/testing/mock-game-harness';
import { MockGameStore } from '../src/game-engine/testing/mock-game-store';
import { GameFailurePolicy } from '../src/game-engine/core/game-failure-policy';
import { createLearningTestDatabase } from './helpers/learning-test-database';

jest.mock('@langchain/openai', () => ({ ChatOpenAI: jest.fn() }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const content = (event: Event) => event.content as Record<string, unknown>;
const unavailable = () =>
  Object.assign(new Error('scripted provider unavailable'), { status: 503 });

describe('standard six player recovery through executor, engine and agent runtime', () => {
  let database: Awaited<ReturnType<typeof createLearningTestDatabase>>;
  let prisma: PrismaService;
  let game: MockGame | undefined;
  let gameId: string;
  let players: Player[];
  let config: Partial<Env>;

  beforeAll(async () => {
    database = await createLearningTestDatabase();
    prisma = database.db as unknown as PrismaService;
    await prisma.ruleset.create({
      data: {
        id: 'standard6p',
        name: 'Standard six player recovery test',
        playerCount: 6,
        definition: new MockGameStore().ruleset.definition,
      },
    });
  });

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Recovery tests prohibit network access'));
    const row = await prisma.game.create({
      data: {
        rulesetId: 'standard6p',
        skillVersion: 'v1',
        status: 'running',
      },
    });
    gameId = row.id;
    players = [];
    for (const template of new MockGameStore().players) {
      const agent = await prisma.agent.create({
        data: {
          name: randomUUID(),
          defaultModelName: template.modelName,
          memoryLabel: 'default',
        },
      });
      const { id: _id, agentId: _agentId, gameId: _gameId, ...data } = template;
      players.push(await prisma.player.create({ data: { ...data, gameId, agentId: agent.id } }));
    }
    config = { GAME_MAX_DURATION_MS: 600_000, LLM_CALL_TIMEOUT_MS: 10_000 };
    game = await start();
  });

  afterEach(async () => {
    try {
      const saved = await events();
      expect(saved.filter((event) => event.actionType === A.GAME_STARTED)).toHaveLength(1);
      expect(new Set(saved.map((event) => event.sequence)).size).toBe(saved.length);
      const actions = saved.filter((event) =>
        [A.VOTE, A.SEER_CHECK, A.WITCH_SAVE, A.WITCH_POISON, A.WOLF_KILL].includes(
          event.actionType as never,
        ),
      );
      const keys = actions.map((event) =>
        [event.day, event.actionType, event.actorId, content(event).voteRound ?? 0].join('/'),
      );
      expect(new Set(keys).size).toBe(keys.length);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      await game?.close();
      game = undefined;
      jest.restoreAllMocks();
    }
  });

  const events = () => prisma.event.findMany({ where: { gameId }, orderBy: { sequence: 'asc' } });
  const player = (seat: number) => players.find((entry) => entry.seatNo === seat)!;
  const start = async () => createMockGame('villager', config, { prisma, gameId, recovery: true });

  async function restart() {
    expect(await game!.recovery!.interrupt(gameId)).toBe(true);
    expect((await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).status).toBe(
      'pending_recovery',
    );
    await game!.close();
    game = await start();
    const execution = await game.recovery!.prepareResume(gameId);
    return execution.generation;
  }

  async function finish(generation?: number) {
    const state = await game!.executor.executeGame(gameId, generation);
    expect(state).toMatchObject({ isGameOver: true, winner: 'villager', currentDay: 2 });
    expect(state.votingResults).toBeInstanceOf(Map);
    expect(state.players.find((entry) => entry.seatNo === 4)).toMatchObject({
      hasAntidoteUsed: true,
      hasPoisonUsed: true,
    });
    expect(await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).toMatchObject({
      status: 'finished',
      winnerFaction: 'villager',
      totalDays: 2,
    });
    expect((await events()).filter((event) => event.actionType === A.GAME_ENDED)).toHaveLength(1);
    for (const persisted of await prisma.player.findMany({ where: { gameId } })) {
      const restored = state.players.find((entry) => entry.id === persisted.id)!;
      expect(restored.deathDay).toBe(persisted.deathDay);
      expect(restored.deathCause).toBe(persisted.deathCause);
    }
    expect(game!.analysis.analyzeGame).toHaveBeenCalledTimes(1);
    return state;
  }

  it('finishes a full standard game using the durable production path', async () => {
    await finish();
    expect(await prisma.gameExecutionStep.count({ where: { gameId, completed: false } })).toBe(0);
  });

  it('提交后私有理由记录失败不中止对局，也不产生第二次动作', async () => {
    let failedEventId: string | undefined;
    // Prisma 的 upsert 是重载泛型签名，测试里按实际入参形状收窄后再挂钩。
    const decisionContext = prisma.decisionContext as unknown as {
      upsert: (args: { create: { eventId: string } }) => Promise<unknown>;
    };
    const failing = jest.spyOn(decisionContext, 'upsert').mockImplementationOnce(async (args) => {
      failedEventId = args.create.eventId;
      throw new Error('私有理由记录写入失败');
    });
    await finish();
    failing.mockRestore();
    expect(failedEventId).toBeDefined();
    // 领域效果已经提交，事后记录失败只丢这一条理由来源，对局照常走到终局。
    const checks = (await events()).filter((event) => event.actionType === A.SEER_CHECK);
    expect(checks).toHaveLength(2);
    expect(await prisma.decisionContext.count({ where: { gameId, eventId: failedEventId! } })).toBe(
      0,
    );
    expect(
      await prisma.decisionContext.count({ where: { gameId, eventId: checks.at(-1)!.id } }),
    ).toBe(1);
  });

  it('resumes five generated votes without committing a partial round', async () => {
    const fiveGenerated = deferred();
    const prepare = game!.runtime.prepareContextPublic.bind(game!.runtime);
    const decide = game!.runtime.decide.bind(game!.runtime);
    let decided = 0;
    jest.spyOn(game!.runtime, 'decide').mockImplementation(async (...args) => {
      const result = await decide(...args);
      if ((args[0] as { scenario?: string }).scenario === 'vote' && ++decided === 5)
        fiveGenerated.resolve();
      return result;
    });
    jest.spyOn(game!.runtime, 'prepareContextPublic').mockImplementation(async (...args) => {
      if (args[0].playerId === player(6).id && args[0].scenario === 'vote') {
        await fiveGenerated.promise;
        throw new Error('sixth voter disconnected before context');
      }
      return prepare(...args);
    });
    await expect(game!.executor.executeGame(gameId)).rejects.toThrow('sixth voter disconnected');
    // 整批提交：第六人没有生成之前，本轮一张票都不可见。
    expect((await events()).filter((event) => event.actionType === A.VOTE)).toHaveLength(0);

    const generation = await restart();
    const contexts: Awaited<ReturnType<typeof prepare>>[] = [];
    const resumedPrepare = game!.runtime.prepareContextPublic.bind(game!.runtime);
    jest.spyOn(game!.runtime, 'prepareContextPublic').mockImplementation(async (...args) => {
      const context = await resumedPrepare(...args);
      if (args[0].scenario === 'vote') contexts.push(context);
      return context;
    });
    await finish(generation);
    // 恢复只补第六人；其余五人复用已生成的候选。
    expect(
      game!.model.requests
        .filter((request) => request.day === 1 && request.action === 'cast_vote')
        .map((request) => request.seat),
    ).toEqual([6]);
    // 全部投票输入仍停在轮次开始前的水位，看不到本轮任何一张票。
    expect(contexts).toHaveLength(6);
    for (const context of contexts) {
      expect(
        context.replay!.evidence.some((event) => event.actionType === A.VOTE && event.day === 1),
      ).toBe(false);
    }
    expect(
      (await events()).filter(
        (event) =>
          event.actionType === A.VOTE &&
          event.day === 1 &&
          Number(content(event).voteRound ?? 0) === 0,
      ),
    ).toHaveLength(6);
  });

  it('continues sequential speech with prior speakers visible and no repeated speech model calls', async () => {
    const record = game!.runtime.recordExperienceUsages.bind(game!.runtime);
    let speeches = 0;
    jest
      .spyOn(game!.runtime, 'recordExperienceUsages')
      .mockImplementation(async (context, event) => {
        if (context.scenario === 'day_speech' && ++speeches === 2)
          throw new Error('disconnect after second public speech');
        return record(context, event);
      });
    await expect(game!.executor.executeGame(gameId)).rejects.toThrow('disconnect after second');
    const committed = (await events()).filter(
      (event) => event.actionType === A.SPEECH && event.visibility === 'public',
    );
    expect(committed).toHaveLength(2);
    const generation = await restart();
    const prepare = game!.runtime.prepareContextPublic.bind(game!.runtime);
    const positions: Array<{ seat: number; completed: number[]; evidence: string[] }> = [];
    jest.spyOn(game!.runtime, 'prepareContextPublic').mockImplementation(async (...args) => {
      const context = await prepare(...args);
      if (context.scenario === 'day_speech')
        positions.push({
          seat: context.player.seatNo!,
          completed: context.replay!.position!.completedSeats ?? [],
          evidence: context.replay!.evidence.map((event) => event.id),
        });
      return context;
    });
    await finish(generation);
    const committedSeats = committed.map((event) => playerSeat(event.actorId!));
    const publicSpeechRequests = game!.model.requests.filter(
      (request) =>
        request.day === 1 &&
        request.kind === 'stream' &&
        Array.isArray(request.messages) &&
        String(request.messages[0].content).includes('阶段：普通发言'),
    );
    expect(publicSpeechRequests.length).toBeGreaterThan(0);
    expect(
      publicSpeechRequests.filter((request) => committedSeats.includes(request.seat)),
    ).toHaveLength(0);
    const third = positions.find((position) => position.completed.length === 2)!;
    expect(third).toBeDefined();
    expect(third.completed).toEqual(committedSeats);
    expect(third.evidence).toEqual(expect.arrayContaining(committed.map((event) => event.id)));
    const saved = await events();
    const firstVote = saved.find((event) => event.actionType === A.VOTE)!.sequence;
    const daySpeeches = saved.filter(
      (event) =>
        event.actionType === A.SPEECH &&
        event.visibility === 'public' &&
        event.day === 1 &&
        event.sequence < firstVote,
    );
    expect(daySpeeches).toHaveLength(6);
    expect(daySpeeches.slice(0, 2)).toEqual(committed);
    expect(
      daySpeeches.filter((event) => committed.some((prior) => prior.actorId === event.actorId)),
    ).toHaveLength(2);
  });

  it('keeps the wolf proposal batch private while reusing the preceding discussion', async () => {
    const proposalCommitted = deferred();
    const prepare = game!.runtime.prepareContextPublic.bind(game!.runtime);
    const record = game!.runtime.recordExperienceUsages.bind(game!.runtime);
    jest
      .spyOn(game!.runtime, 'recordExperienceUsages')
      .mockImplementation(async (context, event) => {
        await record(context, event);
        if (event.actionType === 'wolf_proposal') proposalCommitted.resolve();
      });
    jest.spyOn(game!.runtime, 'prepareContextPublic').mockImplementation(async (...args) => {
      if (args[0].playerId === player(2).id && args[0].actionType === 'wolf_proposal') {
        await proposalCommitted.promise;
        throw new Error('disconnect before the second wolf proposal');
      }
      return prepare(...args);
    });
    await expect(game!.executor.executeGame(gameId)).rejects.toThrow(
      'disconnect before the second',
    );
    const committed = await events();
    expect(committed.filter((event) => event.actionType === 'wolf_proposal')).toHaveLength(1);
    const generation = await restart();
    const resumedPrepare = game!.runtime.prepareContextPublic.bind(game!.runtime);
    const proposalContexts: Awaited<ReturnType<typeof prepare>>[] = [];
    jest.spyOn(game!.runtime, 'prepareContextPublic').mockImplementation(async (...args) => {
      const context = await resumedPrepare(...args);
      if (args[0].actionType === 'wolf_proposal') proposalContexts.push(context);
      return context;
    });
    await finish(generation);
    expect(
      game!.model.requests
        .filter((request) => request.day === 1 && request.action === 'propose_kill')
        .map((request) => request.seat),
    ).toEqual([2]);
    const firstNightContexts = proposalContexts.filter(
      (context) => context.replay!.position.day === 1,
    );
    expect(firstNightContexts).toHaveLength(2);
    for (const context of firstNightContexts)
      expect(context.replay!.evidence.some((event) => event.actionType === 'wolf_proposal')).toBe(
        false,
      );
    const secondNightContext = proposalContexts.find(
      (context) => context.replay!.position.day === 2,
    );
    expect(secondNightContext).toBeDefined();
    expect(
      secondNightContext!.replay!.evidence.filter(
        (event) => event.day === 1 && event.actionType === 'wolf_proposal',
      ),
    ).toHaveLength(2);
    const saved = await events();
    for (const event of committed)
      expect(saved.find((entry) => entry.id === event.id)).toEqual(event);
  });

  const playerSeat = (id: string) => players.find((entry) => entry.id === id)!.seatNo!;

  it('keeps the committed explosion winner and skips the canceled competitor after restart', async () => {
    const releaseLoser = deferred();
    game!.model.beforeRequest = async (request) => {
      if (request.action === 'explode' && request.seat === 2) await releaseLoser.promise;
    };
    game!.model.decisionOverride = (request, decision) =>
      request.action === 'explode' && request.seat === 1
        ? { action: 'explode', reason: 'test interruption' }
        : decision;
    const record = game!.runtime.recordExperienceUsages.bind(game!.runtime);
    jest
      .spyOn(game!.runtime, 'recordExperienceUsages')
      .mockImplementation(async (context, event) => {
        if (event.actionType === 'wolf_explode')
          throw new Error('disconnect after explosion committed');
        return record(context, event);
      });
    try {
      await expect(game!.executor.executeGame(gameId)).rejects.toThrow(
        'disconnect after explosion',
      );
      const committed = (await events()).filter((event) => event.actionType === 'wolf_explode');
      expect(committed).toHaveLength(1);
      expect(committed[0]).toMatchObject({ actorId: player(1).id, content: { action: 'explode' } });
      const losingRequest = game!.model.requests.find(
        (request) => request.action === 'explode' && request.seat === 2,
      );
      if (losingRequest) expect(losingRequest.signal.aborted).toBe(true);
      releaseLoser.resolve();
      const generation = await restart();
      const state = await finish(generation);
      expect(game!.model.requests.filter((request) => request.day === 1)).toHaveLength(0);
      expect(state.players.find((entry) => entry.seatNo === 1)).toMatchObject({
        isAlive: false,
        deathDay: 1,
        deathCause: 'self_destruct',
      });
      const saved = await events();
      expect(saved.filter((event) => event.actionType === 'wolf_explode')).toEqual(committed);
      expect(
        saved.some(
          (event) =>
            event.day === 1 &&
            (event.actionType === A.VOTE ||
              (event.actionType === A.SPEECH && event.visibility === 'public')),
        ),
      ).toBe(false);
      expect(
        saved.filter((event) => event.actionType === A.WOLF_KILL).map((event) => event.day),
      ).toEqual([1, 2]);
    } finally {
      releaseLoser.resolve();
    }
  });

  it('retains the fallback budget consumed by a completed node across restart', async () => {
    await game!.close();
    config.GAME_MAX_MODEL_FALLBACKS = 1;
    game = await start();
    game.model.beforeRequest = (request) => {
      if (request.action === 'check_identity') throw unavailable();
    };
    const prepare = game.runtime.prepareContextPublic.bind(game.runtime);
    jest.spyOn(game.runtime, 'prepareContextPublic').mockImplementation(async (...args) => {
      if (args[0].scenario === 'day_speech') throw new Error('disconnect before public speech');
      return prepare(...args);
    });
    await expect(game.executor.executeGame(gameId)).rejects.toThrow('disconnect before public');
    const generation = await restart();
    game!.model.beforeRequest = (request) => {
      if (request.action === 'check_identity') throw unavailable();
    };
    await expect(game!.executor.executeGame(gameId, generation)).rejects.toThrow(
      '降级次数已耗尽 (1/1)',
    );
    expect(
      await prisma.gameExecutionStep.count({
        where: {
          gameId,
          completed: true,
          key: { contains: '/fallback/' },
        },
      }),
    ).toBe(1);
    expect((await events()).filter((event) => event.actionType === A.SEER_CHECK)).toHaveLength(1);
    expect((await events()).some((event) => event.actionType === A.GAME_ENDED)).toBe(false);
  });

  it('reserves an already spent fallback before another voter fails on replay', async () => {
    await game!.close();
    config.GAME_MAX_MODEL_FALLBACKS = 1;
    game = await start();
    const fallbackConsumed = deferred();
    const consume = GameFailurePolicy.prototype.consumePersisted;
    let consumed = 0;
    jest.spyOn(GameFailurePolicy.prototype, 'consumePersisted').mockImplementation(async function (
      this: GameFailurePolicy,
      ...args
    ) {
      const result = await consume.apply(this, args);
      if (++consumed === 1) fallbackConsumed.resolve();
      return result;
    });
    const prepare = game.runtime.prepareContextPublic.bind(game.runtime);
    jest.spyOn(game.runtime, 'prepareContextPublic').mockImplementation(async (...args) => {
      if (args[0].scenario === 'vote' && args[0].playerId === player(3).id) {
        await fallbackConsumed.promise;
        throw new Error('disconnect after another voter spent fallback budget');
      }
      return prepare(...args);
    });
    game.model.beforeRequest = (request) => {
      if (request.action === 'cast_vote' && request.seat === 5) throw unavailable();
    };
    await expect(game.executor.executeGame(gameId)).rejects.toThrow(
      'disconnect after another voter',
    );
    expect(
      game.model.requests.filter((request) => request.action === 'cast_vote' && request.seat === 5),
    ).toHaveLength(2);
    const fallbackSteps = () =>
      prisma.gameExecutionStep.count({
        where: { gameId, completed: true, key: { contains: '/fallback/' } },
      });
    expect(await fallbackSteps()).toBe(1);
    expect((await events()).filter((event) => event.actionType === A.VOTE)).toHaveLength(0);

    const generation = await restart();
    game!.model.beforeRequest = (request) => {
      if (request.action === 'cast_vote' && request.seat === 3) throw unavailable();
    };
    await expect(game!.executor.executeGame(gameId, generation)).rejects.toThrow('降级次数已耗尽');
    // 上一代已花掉的额度被保留：第五人不再请求模型，也没有第二份额度可花。
    expect(
      game!.model.requests.filter(
        (request) => request.action === 'cast_vote' && request.seat === 5,
      ),
    ).toHaveLength(0);
    expect(await fallbackSteps()).toBe(1);
  });

  it('同一轮里同时失败的投票者不会各自扣掉一份降级额度', async () => {
    await game!.close();
    config.GAME_MAX_MODEL_FALLBACKS = 1;
    game = await start();
    const voters = [player(3).id, player(5).id];
    const prepare = game.runtime.prepareContextPublic.bind(game.runtime);
    const bothReady = deferred();
    let arrived = 0;
    jest.spyOn(game.runtime, 'prepareContextPublic').mockImplementation(async (...args) => {
      if (args[0].scenario === 'vote' && voters.includes(args[0].playerId)) {
        if (++arrived === voters.length) bothReady.resolve();
        await bothReady.promise;
      }
      return prepare(...args);
    });
    game.model.beforeRequest = (request) => {
      if (request.action === 'cast_vote' && [3, 5].includes(request.seat)) throw unavailable();
    };
    // 两个失败同时进入额度占用，避免退化成先后串行。
    const consume = GameFailurePolicy.prototype.consumePersisted;
    const bothConsuming = deferred();
    let consuming = 0;
    jest.spyOn(GameFailurePolicy.prototype, 'consumePersisted').mockImplementation(async function (
      this: GameFailurePolicy,
      ...args
    ) {
      if (++consuming === voters.length) bothConsuming.resolve();
      await bothConsuming.promise;
      return consume.apply(this, args);
    });
    await expect(game!.executor.executeGame(gameId)).rejects.toThrow('降级次数已耗尽');
    expect(
      await prisma.gameExecutionStep.count({
        where: { gameId, completed: true, key: { contains: '/fallback/' } },
      }),
    ).toBe(1);
    // 额度耗尽时整轮不提交：既没有部分投票，也没有多出来的弃票。
    expect((await events()).filter((event) => event.actionType === A.VOTE)).toHaveLength(0);
  });
});
