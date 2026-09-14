import { createAgentRuntime } from '../testing/agent-runtime.fixture';
import type { ConfigService } from '@nestjs/config';
import { ACTION_TYPES, AGENT_SCENARIOS, ROLES } from '@ai-werewolf/shared';
import type { Env } from '../config/env.validation';
import type { PrismaService } from '../prisma/prisma.service';
import type { MemoryService } from '../memory/memory.service';
import type { GlobalMemoryService } from '../memory/global-memory.service';
import type { KnowledgeService } from '../knowledge/knowledge.service';
import type { SkillLoaderService } from '../skills/skill-loader.service';
import type { SpeechSummarizerService } from '../speech-summarizer/speech-summarizer.service';
import type { LangfuseService } from '../observability/langfuse.service';
import type { PromptService } from '../observability/prompt.service';

jest.mock('../observability/langfuse.service', () => ({ LangfuseService: jest.fn() }));
jest.mock('../observability/prompt.service', () => ({ PromptService: jest.fn() }));
jest.mock('../speech-summarizer/speech-summarizer.service', () => ({
  SpeechSummarizerService: jest.fn(),
}));
jest.mock('@langchain/openai', () => ({ ChatOpenAI: jest.fn() }));

type TestableAgentRuntime = {
  prepareContext(input: {
    gameId: string;
    playerId: string;
    scenario: (typeof AGENT_SCENARIOS)[keyof typeof AGENT_SCENARIOS];
  }): Promise<unknown>;
  assembleSystemPrompt: jest.Mock;
};

describe('AgentRuntimeService memory retrieval', () => {
  it('先暂存经验注入，等真实行为事件落库后再精确记录', async () => {
    const player = {
      id: 'player-1',
      gameId: 'game-1',
      agentId: 'agent-1',
      memoryLabelSnapshot: 'default',
      role: ROLES.VILLAGER,
      game: { id: 'game-1' },
    };
    const prisma = {
      player: {
        findUnique: jest.fn().mockResolvedValue(player),
        findMany: jest.fn().mockResolvedValue([{ agentId: 'agent-2', seatNo: 2 }]),
      },
      event: { findMany: jest.fn().mockResolvedValue([]) },
      decisionContext: { upsert: jest.fn() },
    } as unknown as PrismaService;
    const memoryService = {
      retrieveActiveMemories: jest.fn().mockResolvedValue([]),
      retrieveExperience: jest.fn().mockResolvedValue({
        lessons: [
          { id: 'm1', type: 'lesson', title: 't', content: 'c', importance: 0.8, similarity: 0.9 },
          { id: 'm3', type: 'lesson', title: 't', content: 'c', importance: 0.7, similarity: 0.3 },
        ],
        playerModels: [
          { id: 'm2', type: 'player_model', title: 't', content: 'c', importance: 0.5 },
        ],
      }),
      recordUsages: jest.fn().mockResolvedValue(undefined),
    } as unknown as MemoryService;
    const globalMemoryService = {
      retrieveActivePatterns: jest.fn().mockResolvedValue([]),
    } as unknown as GlobalMemoryService;
    const knowledgeService = {
      retrieve: jest.fn().mockResolvedValue([]),
    } as unknown as KnowledgeService;
    const speechSummarizer = {
      readPersonalJudgments: jest.fn().mockResolvedValue({
        recentSpeeches: [],
        olderSpeechesSummary: [],
        recentJudgments: [],
        olderJudgmentsSummary: [],
      }),
    } as unknown as SpeechSummarizerService;
    const service = createAgentRuntime(
      { get: jest.fn().mockReturnValue(true) } as unknown as ConfigService<Env, true>,
      prisma,
      memoryService,
      globalMemoryService,
      knowledgeService,
      {} as SkillLoaderService,
      speechSummarizer,
      {} as LangfuseService,
      { captureGameSnapshot: jest.fn().mockResolvedValue({}) } as unknown as PromptService,
    );
    const runtime = service as unknown as TestableAgentRuntime;

    runtime.assembleSystemPrompt = jest.fn().mockResolvedValue('system prompt');

    const contextData = await service.prepareContextPublic({
      gameId: 'game-1',
      playerId: 'player-1',
      scenario: AGENT_SCENARIOS.VOTE,
      actionType: 'vote',
      position: { day: 1, phase: 'AGENT_SCENARIOS.VOTE', round: 0, aliveSeats: [1, 2, 3, 4, 5, 6] },
    });

    expect(memoryService.retrieveActiveMemories).toHaveBeenCalledWith('agent-1', 'default', {
      types: ['persona', 'strategy'],
    });
    expect(memoryService.retrieveExperience).toHaveBeenCalledWith({
      agentId: 'agent-1',
      label: 'default',
      opponentAgentIds: ['agent-2'],
      query: expect.stringContaining('投票'),
      facts: expect.any(Array),
      role: ROLES.VILLAGER,
      scenario: AGENT_SCENARIOS.VOTE,
    });
    expect(memoryService.recordUsages).not.toHaveBeenCalled();
    // 攻略知识库：VOTE 场景下按当前角色查询（此处 mock 返回空，验证调用即注入链路接通）
    expect(knowledgeService.retrieve).toHaveBeenCalledWith(
      expect.stringContaining('投票'),
      ROLES.VILLAGER,
      AGENT_SCENARIOS.VOTE,
      expect.objectContaining({ situation: expect.objectContaining({ actionType: 'vote' }) }),
    );

    await service.recordExperienceUsages(contextData, {
      id: 'event-1',
      gameId: 'game-1',
      actorId: 'player-1',
      actionType: ACTION_TYPES.VOTE,
      day: 1,
    });

    expect(memoryService.recordUsages).toHaveBeenCalledWith([
      expect.objectContaining({
        memoryId: 'm1',
        eventId: 'event-1',
        gameId: 'game-1',
        actionType: 'vote',
        day: 1,
        triggerMatched: true,
      }),
      expect.objectContaining({
        memoryId: 'm3',
        gameId: 'game-1',
        actionType: 'vote',
        day: 1,
        triggerMatched: false,
      }),
      expect.objectContaining({ memoryId: 'm2', triggerMatched: true }),
    ]);
  });

  it('攻略注入命中后，行为 Event 落库时确认 knowledge usage', async () => {
    const player = {
      id: 'player-1',
      gameId: 'game-1',
      agentId: 'agent-1',
      memoryLabelSnapshot: 'default',
      role: ROLES.SEER,
      game: { id: 'game-1' },
    };
    const prisma = {
      player: {
        findUnique: jest.fn().mockResolvedValue(player),
        findMany: jest.fn().mockResolvedValue([{ agentId: 'agent-2', seatNo: 2 }]),
      },
      event: { findMany: jest.fn().mockResolvedValue([]) },
      decisionContext: { upsert: jest.fn() },
    } as unknown as PrismaService;
    const memoryService = {
      retrieveActiveMemories: jest.fn().mockResolvedValue([]),
      retrieveExperience: jest.fn().mockResolvedValue({ lessons: [], playerModels: [] }),
      recordUsages: jest.fn().mockResolvedValue(undefined),
    } as unknown as MemoryService;
    const globalMemoryService = {
      retrieveActivePatterns: jest.fn().mockResolvedValue([]),
    } as unknown as GlobalMemoryService;
    const knowledgeService = {
      retrieve: jest.fn().mockResolvedValue([
        {
          id: 'chunk-1',
          role: 'seer',
          scenario: 'day_speech',
          trigger: 't',
          action: 'a',
          content: 'c',
          articleTitle: '攻略',
          sectionTitle: null,
          similarity: 0.8,
        },
      ]),
      recordUsages: jest.fn().mockResolvedValue(undefined),
    } as unknown as KnowledgeService;
    const speechSummarizer = {
      readPersonalJudgments: jest.fn().mockResolvedValue({
        recentSpeeches: [],
        olderSpeechesSummary: [],
        recentJudgments: [],
        olderJudgmentsSummary: [],
      }),
    } as unknown as SpeechSummarizerService;
    const service = createAgentRuntime(
      { get: jest.fn().mockReturnValue(true) } as unknown as ConfigService<Env, true>,
      prisma,
      memoryService,
      globalMemoryService,
      knowledgeService,
      {} as SkillLoaderService,
      speechSummarizer,
      {} as LangfuseService,
      { captureGameSnapshot: jest.fn().mockResolvedValue({}) } as unknown as PromptService,
    );
    const runtime = service as unknown as TestableAgentRuntime;

    runtime.assembleSystemPrompt = jest.fn().mockResolvedValue('system prompt');

    const contextData = await service.prepareContextPublic({
      gameId: 'game-1',
      playerId: 'player-1',
      scenario: AGENT_SCENARIOS.DAY_SPEECH,
      actionType: 'speech',
      position: {
        day: 1,
        phase: 'AGENT_SCENARIOS.DAY_SPEECH',
        round: 0,
        aliveSeats: [1, 2, 3, 4, 5, 6],
      },
    });
    expect(contextData).toHaveProperty('pendingKnowledgeUsages', [{ chunkId: 'chunk-1' }]);

    await service.recordExperienceUsages(contextData, {
      id: 'event-1',
      gameId: 'game-1',
      actorId: 'player-1',
      actionType: ACTION_TYPES.SPEECH,
      day: 1,
    });

    expect(knowledgeService.recordUsages).toHaveBeenCalledWith([
      expect.objectContaining({
        chunkId: 'chunk-1',
        eventId: 'event-1',
        gameId: 'game-1',
        playerId: 'player-1',
        scenario: AGENT_SCENARIOS.DAY_SPEECH,
        actionType: ACTION_TYPES.SPEECH,
        day: 1,
      }),
    ]);
  });
});
