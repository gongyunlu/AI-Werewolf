import { createAgentRuntime } from '../testing/agent-runtime.fixture';
import type { ConfigService } from '@nestjs/config';
import { AGENT_SCENARIOS, ROLES } from '@ai-werewolf/shared';
import type { Env } from '../config/env.validation';
import type { PrismaService } from '../prisma/prisma.service';
import type { MemoryService } from '../memory/memory.service';
import type { GlobalMemoryService } from '../memory/global-memory.service';
import type { KnowledgeService } from '../knowledge/knowledge.service';
import type { SkillLoaderService } from '../skills/skill-loader.service';
import type { SpeechSummarizerService } from '../speech-summarizer/speech-summarizer.service';
import type { LangfuseService } from '../observability/langfuse.service';
import type { PromptService } from '../observability/prompt.service';
import type { GameRecoveryService } from '../game-recovery/game-recovery.service';
import { encryptAgentSecret } from '../agents/agent-secret';

jest.mock('../observability/langfuse.service', () => ({ LangfuseService: jest.fn() }));
jest.mock('../observability/prompt.service', () => ({ PromptService: jest.fn() }));
jest.mock('../speech-summarizer/speech-summarizer.service', () => ({
  SpeechSummarizerService: jest.fn(),
}));
jest.mock('@langchain/openai', () => ({
  OpenAIClient: jest.requireActual('@langchain/openai').OpenAIClient,
  ChatOpenAI: jest.fn(),
}));

const SECRET_KEY = 'b'.repeat(64);
const BASE_URL = 'https://deepseek.example/v1';
const API_KEY = 'sk-agent-owned';
const CIPHERTEXT = encryptAgentSecret(API_KEY, SECRET_KEY);

/** 代入 prepareContext 的最小入参。 */
const request = () => ({
  gameId: 'game-1',
  playerId: 'player-1',
  scenario: AGENT_SCENARIOS.DAY_SPEECH,
  actionType: 'speech',
  position: { day: 1, phase: AGENT_SCENARIOS.DAY_SPEECH, round: 0, aliveSeats: [1, 2] },
});

function build(options: {
  accessBaseUrl: string | null;
  accessUsesDefault?: boolean;
  ciphertext?: string | null;
}) {
  const player = {
    id: 'player-1',
    gameId: 'game-1',
    agentId: 'agent-1',
    memoryLabelSnapshot: 'default',
    role: ROLES.VILLAGER,
    seatNo: 1,
    accessBaseUrl: options.accessBaseUrl,
    accessUsesDefault: options.accessUsesDefault,
    game: { id: 'game-1', rulesetId: 'standard6p', experiment: null },
  };
  const prisma = {
    player: {
      findUnique: jest.fn().mockResolvedValue(player),
      findMany: jest.fn().mockResolvedValue([]),
    },
    agent: {
      findUnique: jest.fn().mockResolvedValue({
        baseUrl: options.accessBaseUrl,
        apiKeyCiphertext: options.ciphertext ?? null,
      }),
    },
    event: { findMany: jest.fn().mockResolvedValue([]) },
    decisionContext: { upsert: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;

  // 站在恢复日志的位置记录每次检查点写入的内容
  const checkpoints = new Map<string, unknown>();
  const recovery = {
    value: async (key: string, produce: () => Promise<unknown>) => {
      if (checkpoints.has(key)) return checkpoints.get(key);
      const value = await produce();
      checkpoints.set(key, value);
      return value;
    },
  } as unknown as GameRecoveryService;

  const service = createAgentRuntime(
    {
      get: (key: string) =>
        ({ AGENT_SECRET_KEY: SECRET_KEY, ARK_BASE_URL: BASE_URL, ARK_API_KEY: API_KEY })[key] ??
        true,
    } as unknown as ConfigService<Env, true>,
    prisma,
    {
      retrieveActiveMemories: jest.fn().mockResolvedValue([]),
      retrieveExperience: jest.fn().mockResolvedValue({ lessons: [], playerModels: [] }),
    } as unknown as MemoryService,
    { retrieveActivePatterns: jest.fn().mockResolvedValue([]) } as unknown as GlobalMemoryService,
    { retrieve: jest.fn().mockResolvedValue([]) } as unknown as KnowledgeService,
    {} as SkillLoaderService,
    {
      readPersonalJudgments: jest.fn().mockResolvedValue({
        recentSpeeches: [],
        olderSpeechesSummary: [],
        recentJudgments: [],
        olderJudgmentsSummary: [],
      }),
    } as unknown as SpeechSummarizerService,
    {} as LangfuseService,
    { captureGameSnapshot: jest.fn().mockResolvedValue({}) } as unknown as PromptService,
    recovery,
  );
  (service as unknown as { assembleSystemPrompt: jest.Mock }).assembleSystemPrompt = jest
    .fn()
    .mockResolvedValue('system prompt');

  return { service, checkpoints, prisma };
}

describe('玩家自带接入的执行期取值', () => {
  it('恢复复用上下文检查点时重新取得同端点的最新密钥', async () => {
    const { service, checkpoints, prisma } = build({
      accessBaseUrl: BASE_URL,
      ciphertext: CIPHERTEXT,
    });
    await service.prepareContextPublic(request());
    jest.mocked(prisma.agent.findUnique).mockResolvedValue({
      baseUrl: BASE_URL,
      apiKeyCiphertext: encryptAgentSecret('rotated-key', SECRET_KEY),
    } as never);

    const restored = await service.prepareContextPublic(request());

    expect(restored.access).toEqual({ baseUrl: BASE_URL, apiKey: 'rotated-key' });
    expect(prisma.player.findUnique).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...checkpoints.values()])).not.toContain('rotated-key');
  });

  it('新局的默认接入从快照中识别来源，密钥同样不进检查点', async () => {
    const { service, checkpoints, prisma } = build({
      accessBaseUrl: BASE_URL,
      accessUsesDefault: true,
    });
    const context = await service.prepareContextPublic(request());

    expect(context.access).toEqual({ baseUrl: BASE_URL, apiKey: API_KEY });
    expect(prisma.agent.findUnique).not.toHaveBeenCalled();
    expect(JSON.stringify([...checkpoints.values()])).not.toContain(API_KEY);
  });

  it('密钥在检查点之外解密，检查点里只有端点', async () => {
    const { service, checkpoints } = build({
      accessBaseUrl: BASE_URL,
      ciphertext: CIPHERTEXT,
    });

    const context = await service.prepareContextPublic(request());

    expect(context.access).toEqual({ baseUrl: BASE_URL, apiKey: API_KEY });
    const saved = JSON.stringify([...checkpoints.entries()]);
    expect(saved).not.toContain(API_KEY);
    expect(saved).not.toContain(CIPHERTEXT);
    // 端点照旧进检查点：续跑要按当时的端点重放
    expect(saved).toContain(BASE_URL);
  });

  it('端点已固定但 Agent 没有可用密钥时直接失败，不静默回落默认接入', async () => {
    const { service } = build({ accessBaseUrl: BASE_URL, ciphertext: null });

    await expect(service.prepareContextPublic(request())).rejects.toThrow(/没有可用密钥/);
  });

  it('没有开局端点的玩家保持走默认接入，不额外查 Agent', async () => {
    const { service, prisma } = build({ accessBaseUrl: null });

    const context = await service.prepareContextPublic(request());

    expect(context.access).toBeUndefined();
    expect(prisma.agent.findUnique).not.toHaveBeenCalled();
  });
});
