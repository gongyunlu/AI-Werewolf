import type { ConfigService } from '@nestjs/config';
import { AGENT_SCENARIOS, ROLES } from '@ai-werewolf/shared';
import type { Env } from '../config/env.validation';
import type { PrismaService } from '../prisma/prisma.service';
import type { MemoryService } from '../memory/memory.service';
import type { SkillLoaderService } from '../skills/skill-loader.service';
import type { SpeechSummarizerService } from '../speech-summarizer/speech-summarizer.service';
import type { LangfuseService } from '../observability/langfuse.service';
import type { PromptService } from '../observability/prompt.service';
import { AgentRuntimeService } from './agent-runtime.service';
import type { ChatHistoryService } from './chat-history.service';

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
  getVisibleVisibilities: jest.Mock;
  buildLayeredContext: jest.Mock;
  getCurrentRound: jest.Mock;
  assembleSystemPrompt: jest.Mock;
};

describe('AgentRuntimeService memory retrieval', () => {
  it('准备上下文时只检索 Prompt 会消费的 persona 和 strategy', async () => {
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
        findMany: jest.fn().mockResolvedValue([]),
      },
      event: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const memoryService = {
      retrieveActiveMemories: jest.fn().mockResolvedValue([]),
    } as unknown as MemoryService;
    const speechSummarizer = {
      summarizeForAgent: jest.fn().mockResolvedValue({
        recentSpeeches: [],
        olderSpeechesSummary: [],
        recentJudgments: [],
        olderJudgmentsSummary: [],
      }),
    } as unknown as SpeechSummarizerService;
    const service = new AgentRuntimeService(
      {} as ConfigService<Env, true>,
      prisma,
      memoryService,
      {} as SkillLoaderService,
      speechSummarizer,
      {} as LangfuseService,
      {} as PromptService,
      {} as ChatHistoryService,
    );
    const runtime = service as unknown as TestableAgentRuntime;
    runtime.getVisibleVisibilities = jest.fn().mockResolvedValue([]);
    runtime.buildLayeredContext = jest.fn().mockResolvedValue({
      critical: '',
      recent: '',
      history: '',
    });
    runtime.getCurrentRound = jest.fn().mockResolvedValue(1);
    runtime.assembleSystemPrompt = jest.fn().mockResolvedValue('system prompt');

    await runtime.prepareContext({
      gameId: 'game-1',
      playerId: 'player-1',
      scenario: AGENT_SCENARIOS.NIGHT_ACTION,
    });

    expect(memoryService.retrieveActiveMemories).toHaveBeenCalledWith('agent-1', 'default', {
      types: ['persona', 'strategy'],
    });
  });
});
