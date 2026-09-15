import { Logger, Module, type Type } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module';
import { AgentRuntimeService } from '../agent-runtime/agent-runtime.service';
import { EventBusModule } from '../event-bus/event-bus.module';
import { EventBusService } from '../event-bus/event-bus.service';
import { GameEngine } from '../game-engine/core/game-engine';
import { EventsModule } from '../game-engine/events/events.module';
import { EventWriterService } from '../game-engine/events/event-writer.service';
import { ALL_PRESETS, type GamePreset } from '../game-engine/presets/game-presets';
import { NodeRegistrar } from '../game-engine/nodes/node-registrar.service';
import { createGameState, createPlayer } from '../game-engine/testing/test-utils';
import { GameRecoveryModule } from '../game-recovery/game-recovery.module';
import { LangfuseService } from '../observability/langfuse.service';
import { ObservabilityModule } from '../observability/observability.module';
import { PromptService } from '../observability/prompt.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { GameAnalysisService } from '../reflection/game-analysis.service';
import { ReflectionModule } from '../reflection/reflection.module';
import { SpeechSummarizerModule } from '../speech-summarizer/speech-summarizer.module';
import { SpeechSummarizerService } from '../speech-summarizer/speech-summarizer.service';
import { SseBroadcasterService } from '../sse/sse-broadcaster.service';
import { SseModule } from '../sse/sse.module';
import { GameEngineFactory } from './game-engine.factory';
import { GameExecutorModule } from './game-executor.module';
import { GameExecutorService } from './game-executor.service';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const votePreset: GamePreset = {
  name: '装配隔离测试',
  nightPipeline: ['vote', 'nightResolve'],
  dayPipeline: [],
};

const stateFor = (gameId: string) =>
  createGameState({
    gameId,
    players: [createPlayer(`${gameId}-player`, 1, 'villager', 'villager')],
  });

describe('游戏执行器生产模块装配', () => {
  const modules: TestingModule[] = [];

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('装配测试禁止网络访问'));
  });

  afterEach(async () => {
    await Promise.all(modules.splice(0).map((module) => module.close()));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  async function createComposition() {
    const runtime = {
      validateRequiredSkills: jest.fn(async () => {}),
      prepareContextPublic: jest.fn(async ({ gameId }: { gameId: string }) => ({ gameId })),
      decide: jest.fn(async () => ({ decision: { action: 'abstain' } })),
      recordExperienceUsages: jest.fn(async () => {}),
    };
    const eventWriter = {
      writeGameStartEvent: jest.fn(async ({ gameId }: { gameId: string }) => ({
        id: `${gameId}-start`,
      })),
      writeVoteBatch: jest.fn(
        async (batch: { gameId: string; day: number; votes: Array<Record<string, unknown>> }) =>
          batch.votes.map((vote) => ({
            id: `${batch.gameId}-vote`,
            gameId: batch.gameId,
            actionType: 'vote',
            actorId: vote.actorId,
            day: batch.day,
            content: {
              voteRound: 0,
              voterSeatNo: vote.voterSeatNo,
              targetSeatNo: vote.targetSeatNo,
            },
          })),
      ),
      commitNightResolution: jest.fn(async () => {}),
      writeGameEndEvent: jest.fn(async ({ gameId }: { gameId: string }) => ({
        id: `${gameId}-end`,
      })),
    };
    const prisma = {
      game: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          status: 'running',
          rulesetId: 'standard6p',
          ruleset: { id: 'standard6p' },
          skillVersion: 'v1',
          experiment: null,
          players: stateFor(where.id).players,
        })),
      },
    };
    const replacements: Array<[Type<unknown>, Array<[Type<unknown>, unknown]>]> = [
      [
        ConfigModule,
        [
          [
            ConfigService,
            { get: (key: string) => (key === 'GAME_MAX_DURATION_MS' ? 60_000 : undefined) },
          ],
        ],
      ],
      [PrismaModule, [[PrismaService, prisma]]],
      [AgentRuntimeModule, [[AgentRuntimeService, runtime]]],
      [EventsModule, [[EventWriterService, eventWriter]]],
      [EventBusModule, [[EventBusService, { publish: jest.fn(async () => {}) }]]],
      [SseModule, [[SseBroadcasterService, new SseBroadcasterService()]]],
      [
        SpeechSummarizerModule,
        [[SpeechSummarizerService, { generateDaySummaries: jest.fn(async () => {}) }]],
      ],
      [
        ReflectionModule,
        [
          [
            GameAnalysisService,
            { analyzeGame: jest.fn(async () => ({ judged: 0, reflectPlanned: 0 })) },
          ],
        ],
      ],
      [
        ObservabilityModule,
        [
          [LangfuseService, {}],
          [PromptService, {}],
        ],
      ],
      [GameRecoveryModule, []],
    ];
    // 保留真实 composition module 和节点 module，只替换会访问外部系统的依赖模块。
    const builder = Test.createTestingModule({ imports: [GameExecutorModule] });
    for (const [original, services] of replacements) {
      @Module({})
      class ReplacementModule {}
      builder.overrideModule(original).useModule({
        module: ReplacementModule,
        providers: services.map(([provide, useValue]) => ({ provide, useValue })),
        exports: services.map(([provide]) => provide),
      });
    }
    const module = await builder.compile();
    modules.push(module);
    return {
      module,
      runtime,
      eventWriter,
      factory: module.get(GameEngineFactory),
      executor: module.get(GameExecutorService),
    };
  }

  it('真实模块可解析全部板型节点，执行器通过工厂为每局创建独立引擎', async () => {
    const { module, executor, factory } = await createComposition();
    const registered = module.get(NodeRegistrar).registry.getRegisteredNodes();
    for (const preset of Object.values(ALL_PRESETS)) {
      expect(registered).toEqual(
        expect.arrayContaining([...preset.nightPipeline, ...preset.dayPipeline]),
      );
    }
    expect(registered).not.toContain('nightPipeline');
    expect(registered).not.toContain('dayPipeline');
    expect(() => module.get(GameEngine)).toThrow();
    const create = jest.spyOn(factory, 'create');

    await expect(executor.executeGame('first')).resolves.toMatchObject({
      gameId: 'first',
      isGameOver: true,
    });
    await expect(executor.executeGame('second')).resolves.toMatchObject({
      gameId: 'second',
      isGameOver: true,
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.results[0].value).not.toBe(create.mock.results[1].value);
  });

  it('另一容器启动并完成对局，不会替换已运行对局的玩家运行时', async () => {
    const first = await createComposition();
    const arrived = deferred();
    const release = deferred();
    first.eventWriter.writeGameStartEvent.mockImplementationOnce(async ({ gameId }) => {
      arrived.resolve();
      await release.promise;
      return { id: `${gameId}-start` };
    });
    const running = first.factory.create().run(stateFor('first'), votePreset);
    await arrived.promise;

    const second = await createComposition();
    try {
      await second.factory.create().run(stateFor('second'), votePreset);
    } finally {
      release.resolve();
    }
    await running;

    expect(first.runtime.prepareContextPublic.mock.calls.map(([input]) => input.gameId)).toEqual([
      'first',
    ]);
    expect(second.runtime.prepareContextPublic.mock.calls.map(([input]) => input.gameId)).toEqual([
      'second',
    ]);
    expect(first.eventWriter.writeVoteBatch).toHaveBeenCalledWith(
      expect.objectContaining({ gameId: 'first' }),
    );
    expect(second.eventWriter.writeVoteBatch).toHaveBeenCalledWith(
      expect.objectContaining({ gameId: 'second' }),
    );
  });

  it('同容器两局的取消信号独立，被取消局不能执行后续节点', async () => {
    const { factory, eventWriter, runtime } = await createComposition();
    const arrived = deferred();
    const release = deferred();
    eventWriter.writeGameStartEvent.mockImplementationOnce(async ({ gameId }) => {
      arrived.resolve();
      await release.promise;
      return { id: `${gameId}-start` };
    });
    const controller = new AbortController();
    const running = factory.create().run(stateFor('cancelled'), votePreset, controller.signal);
    const cancelled = expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await arrived.promise;
    controller.abort();
    try {
      await expect(factory.create().run(stateFor('active'), votePreset)).resolves.toMatchObject({
        isGameOver: true,
      });
    } finally {
      release.resolve();
    }
    await cancelled;

    expect(runtime.prepareContextPublic.mock.calls.map(([input]) => input.gameId)).toEqual([
      'active',
    ]);
    expect(eventWriter.writeGameEndEvent).toHaveBeenCalledTimes(1);
    expect(eventWriter.writeGameEndEvent).toHaveBeenCalledWith(
      expect.objectContaining({ gameId: 'active' }),
    );
  });
});
