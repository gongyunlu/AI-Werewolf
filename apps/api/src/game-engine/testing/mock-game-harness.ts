import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { PinoLogger } from 'nestjs-pino';
import type { Job } from 'bullmq';
import type { Env } from '@/config/env.validation';
import type { Event } from '@/generated/prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { RedisService } from '@/redis/redis.service';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import { ModelCallService } from '@/llm/model-call.service';
import { ModelGenerationService } from '@/llm/model-generation.service';
import { testModelCapabilities } from '@/testing/model-capabilities.fixture';
import { PlayerTurnService } from '@/player-turn/player-turn.service';
import { MemoryService } from '@/memory/memory.service';
import { GlobalMemoryService } from '@/memory/global-memory.service';
import { KnowledgeService, type KnowledgeHit } from '@/knowledge/knowledge.service';
import { SkillLoaderService } from '@/skills/skill-loader.service';
import { SpeechSummarizerService } from '@/speech-summarizer/speech-summarizer.service';
import { LangfuseService } from '@/observability/langfuse.service';
import { PromptService } from '@/observability/prompt.service';
import { EventBusService } from '@/event-bus/event-bus.service';
import { SseBroadcasterService } from '@/sse/sse-broadcaster.service';
import { GameAnalysisService } from '@/reflection/game-analysis.service';
import { GameExecutorService } from '@/game-executor/game-executor.service';
import { GameEngineFactory } from '@/game-executor/game-engine.factory';
import { VoteTurnAdapter } from '@/game-executor/vote-turn.adapter';
import { VOTE_TURN_PORT } from '@/game-engine/ports/vote-turn.port';
import { GameWorkerService } from '@/game-queue/game-worker.service';
import type { GameJobData } from '@/game-queue/game-queue.service';
import { EventWriterService } from '../events/event-writer.service';
import { GameEngineModule } from '../core/game-engine.module';
import { MockGameStore } from './mock-game-store';
import { ScriptedGameModel } from './scripted-game-model';
import { GameRecoveryService } from '@/game-recovery/game-recovery.service';
import { retrieveFrozenMemories, type ExperimentSnapshot } from '@/evaluation/experiment-snapshot';

interface MockGameDependencies {
  prisma?: PrismaService;
  gameId?: string;
  recovery?: boolean;
}

export async function createMockGame(
  winner: 'villager' | 'werewolf' = 'villager',
  overrides: Partial<Env> = {},
  dependencies: MockGameDependencies = {},
) {
  const store = new MockGameStore();
  const model = new ScriptedGameModel(winner);
  jest
    .mocked(ChatOpenAI)
    .mockImplementation((options) => model.create(String(options?.model)) as never);
  const config: Partial<Env> = {
    ARK_API_KEY: 'mock-key',
    ARK_BASE_URL: 'https://mock.invalid',
    ARK_DEFAULT_MODEL: 'mock-coordinator',
    MODEL_CAPABILITIES: testModelCapabilities('https://mock.invalid', [
      'mock-coordinator',
      ...Array.from({ length: 18 }, (_, i) => `mock-seat-${i + 1}`),
    ]),
    TURN_REFLECTION_MAX_ROUNDS: 0,
    GAME_MAX_DAYS: 5,
    GAME_MAX_DURATION_MS: 60_000,
    LLM_CALL_TIMEOUT_MS: 1000,
    LLM_FIRST_CHUNK_TIMEOUT_MS: 1000,
    LLM_STREAM_IDLE_TIMEOUT_MS: 1000,
    LLM_STREAM_MAX_DURATION_MS: 5000,
    LLM_CIRCUIT_MIN_SAMPLES: 100,
    LLM_CIRCUIT_COOLDOWN_MS: 30_000,
    ...overrides,
  };
  const published: Event[] = [];
  const bus = {
    restore: jest.fn(async (_gameId: string) => {}),
    publish: jest.fn(async (event: Event) => {
      published.push(event);
    }),
  };
  const emit = jest.fn();
  const broadcaster = {
    emit,
    complete: jest.fn(),
    getOrCreate: jest.fn(),
    forExecution: () => ({ emit }),
  };
  const memory = {
    retrieveFrozen: jest.fn(
      async (
        snapshot: ExperimentSnapshot,
        input: Omit<Parameters<typeof retrieveFrozenMemories>[1], 'queryVector'>,
      ) => retrieveFrozenMemories(snapshot.memories, { ...input, queryVector: [1, 0] }),
    ),
    retrieveActiveMemories: jest.fn(async () => []),
    retrieveExperience: jest.fn(async () => ({
      lessons: [
        {
          id: 'lesson-1',
          type: 'lesson',
          title: '测试经验',
          content: '依据可见信息行动。',
          importance: 1,
          similarity: 1,
        },
      ],
      playerModels: [],
    })),
    recordUsages: jest.fn(async (_usages: Array<{ eventId: string }>) => {}),
  };
  if (dependencies.prisma) {
    const gamePlayers = await dependencies.prisma.player.findMany({
      where: { gameId: dependencies.gameId },
    });
    const rows = await dependencies.prisma.memory.createManyAndReturn({
      data: gamePlayers.map((player) => ({
        agentId: player.agentId,
        label: 'default',
        type: 'lesson',
        title: '测试经验',
        content: '依据可见信息行动。',
      })),
    });
    const lessons = new Map(rows.map((lesson) => [lesson.agentId, lesson.id]));
    memory.retrieveExperience.mockImplementation(async (...args: unknown[]) => ({
      lessons: [
        {
          id: lessons.get((args[0] as { agentId: string }).agentId)!,
          type: 'lesson',
          title: '测试经验',
          content: '依据可见信息行动。',
          importance: 1,
          similarity: 1,
        },
      ],
      playerModels: [],
    }));
  }
  const analysis = { analyzeGame: jest.fn(async () => ({ judged: 0, reflectPlanned: 0 })) };
  const knowledge = {
    retrieve: jest.fn(async (..._args: unknown[]): Promise<KnowledgeHit[]> => []),
  };
  const summaries = {
    readPersonalJudgments: jest.fn(async () => ({
      recentSpeeches: [],
      olderSpeechesSummary: [],
      recentJudgments: [],
      olderJudgmentsSummary: [],
    })),
    generateDaySummaries: jest.fn(async () => {}),
  };
  // 使用生产模块的节点清单，但不导入会建立数据库、Redis、队列连接的模块。
  const nodes = Reflect.getMetadata('providers', GameEngineModule) as Array<
    new (...args: never[]) => unknown
  >;
  const module = await Test.createTestingModule({
    providers: [
      ...nodes,
      GameExecutorService,
      GameEngineFactory,
      VoteTurnAdapter,
      { provide: VOTE_TURN_PORT, useExisting: VoteTurnAdapter },
      GameWorkerService,
      AgentRuntimeService,
      ModelCallService,
      ModelGenerationService,
      PlayerTurnService,
      EventWriterService,
      PromptService,
      SkillLoaderService,
      LangfuseService,
      ...(dependencies.recovery ? [GameRecoveryService] : []),
      {
        provide: ConfigService,
        useValue: {
          get: (key: keyof Env) => config[key],
          getOrThrow: (key: keyof Env) => {
            if (config[key] === undefined) throw new Error(`Missing test config ${key}`);
            return config[key];
          },
        },
      },
      { provide: PrismaService, useValue: dependencies.prisma ?? store.prisma },
      { provide: RedisService, useValue: store.redis },
      { provide: EventBusService, useValue: bus },
      { provide: SseBroadcasterService, useValue: broadcaster },
      { provide: MemoryService, useValue: memory },
      {
        provide: GlobalMemoryService,
        useValue: { retrieveActivePatterns: jest.fn(async () => []) },
      },
      { provide: KnowledgeService, useValue: knowledge },
      { provide: SpeechSummarizerService, useValue: summaries },
      { provide: GameAnalysisService, useValue: analysis },
      {
        provide: PinoLogger,
        useValue: { setContext: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      },
    ],
  }).compile();
  const executor = module.get(GameExecutorService);
  const worker = module.get(GameWorkerService);
  const execution = jest.spyOn(executor, 'executeGame');
  const job = {
    id: 'mock-game',
    data: { gameId: dependencies.gameId ?? store.gameId },
    attemptsMade: 0,
    opts: { attempts: 3 },
  } as Job<GameJobData>;
  return {
    store,
    model,
    bus,
    published,
    broadcaster,
    memory,
    knowledge,
    prompts: module.get(PromptService),
    skills: module.get(SkillLoaderService),
    summaries,
    analysis,
    executor,
    worker,
    execution,
    job,
    runtime: module.get(AgentRuntimeService),
    recovery: dependencies.recovery ? module.get(GameRecoveryService) : undefined,
    run: () => worker.process(job),
    close: () => module.close(),
  };
}

export type MockGame = Awaited<ReturnType<typeof createMockGame>>;
