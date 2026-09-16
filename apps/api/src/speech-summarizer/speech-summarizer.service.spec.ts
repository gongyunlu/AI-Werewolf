import { ChatOpenAI } from '@langchain/openai';
import { ROLES } from '@ai-werewolf/shared';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import type { AgentJudgmentService } from '../agent-judgment/agent-judgment.service';
import type { PromptService } from '../observability/prompt.service';
import type { LangfuseService } from '../observability/langfuse.service';
import type { Env } from '../config/env.validation';
import { encryptAgentSecret } from '../agents/agent-secret';
import { SpeechSummarizerService } from './speech-summarizer.service';

jest.mock('@langchain/openai', () => ({
  OpenAIClient: jest.requireActual('@langchain/openai').OpenAIClient,
  ChatOpenAI: jest.fn(),
}));

const SECRET_KEY = 'd'.repeat(64);
const AGENT_KEY = 'sk-agent-owned';
const AGENT_BASE_URL = 'https://api.deepseek.com';
const ARK_BASE_URL = 'https://ark.example/api/v3';

function build(accessBaseUrl: string | null) {
  // 判断链只需走通，返回空列表即可；本用例断言的是调用落在哪个端点上。
  jest.mocked(ChatOpenAI).mockReturnValue({
    pipe: jest.fn().mockReturnValue({ invoke: jest.fn().mockResolvedValue({ judgments: [] }) }),
  } as never);

  const prisma = {
    // 第一次查询是「更早日期」的全局摘要，置空即跳过；第二次才是当天发言。
    event: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ id: 'speech-1', content: { seatNo: 2, speech: '我认4号真预。' } }]),
    },
    player: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'player-1',
          gameId: 'game-1',
          agentId: 'agent-1',
          seatNo: 2,
          role: ROLES.VILLAGER,
          modelName: 'deepseek-flash',
          accessBaseUrl,
        },
      ]),
    },
    game: { findUnique: jest.fn().mockResolvedValue({ experiment: null }) },
    agent: {
      findUnique: jest.fn().mockResolvedValue({
        baseUrl: accessBaseUrl,
        apiKeyCiphertext: encryptAgentSecret(AGENT_KEY, SECRET_KEY),
      }),
    },
    speechSummary: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn() },
  } as unknown as PrismaService;

  const config = {
    get: (key: string) =>
      ({
        AGENT_SECRET_KEY: SECRET_KEY,
        ARK_API_KEY: 'ark-env-key',
        ARK_BASE_URL,
      })[key],
  } as unknown as ConfigService<Env, true>;

  const judgments = {
    getJudgmentsByDay: jest.fn().mockResolvedValue([]),
    getHistoryJudgments: jest.fn().mockResolvedValue([]),
    saveJudgments: jest.fn(),
  } as unknown as AgentJudgmentService;

  const prompts = {
    render: jest
      .fn()
      .mockResolvedValue({ name: 'summarizer/judgment', version: 1, text: 'prompt' }),
  } as unknown as PromptService;

  const service = new SpeechSummarizerService(config, prisma, judgments, prompts, {
    trace: jest.fn().mockReturnValue({}),
  } as unknown as LangfuseService);

  return { service };
}

describe('逐玩家判断使用玩家自己的接入', () => {
  afterEach(() => jest.restoreAllMocks());

  it('Agent 自带接入时，判断请求打到该端点与密钥', async () => {
    const { service } = build(AGENT_BASE_URL);

    await service.generateDaySummaries('game-1', 1);

    expect(ChatOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: AGENT_KEY,
        model: 'deepseek-flash',
        configuration: { baseURL: AGENT_BASE_URL },
      }),
    );
  });

  it('没有自带接入的玩家回落到环境变量里的默认接入', async () => {
    const { service } = build(null);

    await service.generateDaySummaries('game-1', 1);

    expect(ChatOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'ark-env-key',
        configuration: { baseURL: ARK_BASE_URL },
      }),
    );
  });
});
