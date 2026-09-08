import { ReflectionService } from './reflection.service';
import { PrismaService } from '../prisma/prisma.service';
import { PromptService } from '../observability/prompt.service';
import { StructuredLlmService } from '../observability/structured-llm.service';
import { MemoryService, type CreateMemoryInput } from '../memory/memory.service';
import { GameReviewService } from './game-review.service';
import { FACTIONS, ROLES } from '@ai-werewolf/shared';

/** 事务回调拿到的 tx，只覆盖反思用到的写面 */
function createMockTx() {
  return {
    memory: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    agentPerformance: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
  };
}

function createMocks() {
  const tx = createMockTx();
  const prisma = {
    player: { findUnique: jest.fn(), findMany: jest.fn() },
    agentPerformance: { findUnique: jest.fn() },
    decisionJudgment: { findMany: jest.fn() },
    event: { findMany: jest.fn() },
    agentJudgment: { findMany: jest.fn() },
    memory: { findMany: jest.fn() },
    $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    $executeRaw: jest.fn().mockResolvedValue(1),
  };

  const promptService = {
    render: jest.fn().mockResolvedValue({ text: 'rendered', name: 'x', version: 1 }),
  };
  const structuredLlm = { invoke: jest.fn() };
  const memoryService = {
    createMemories: jest.fn((inputs: CreateMemoryInput[], _tx?: unknown) =>
      inputs.map((input, i) => ({ id: `m${i}`, content: input.content })),
    ),
    embedMemories: jest.fn(),
    deactivateGameMemories: jest.fn(),
  };
  const gameReviewService = {
    loadReview: jest.fn().mockResolvedValue({ narrative: '复盘正文', turningPoints: [] }),
  };

  const service = new ReflectionService(
    prisma as unknown as PrismaService,
    promptService as unknown as PromptService,
    structuredLlm as unknown as StructuredLlmService,
    memoryService as unknown as MemoryService,
    gameReviewService as unknown as GameReviewService,
  );

  return { service, prisma, promptService, structuredLlm, memoryService, gameReviewService, tx };
}

const ME = {
  id: 'p1',
  gameId: 'g1',
  agentId: 'a1',
  seatNo: 1,
  role: ROLES.SEER,
  faction: FACTIONS.VILLAGER,
  deathDay: null,
  memoryLabelSnapshot: 'label-v1',
  agent: { name: '阿一' },
};

const OPPONENTS = [
  {
    agentId: 'a2',
    seatNo: 2,
    role: ROLES.WEREWOLF,
    faction: FACTIONS.WEREWOLF,
    agent: { name: '阿二' },
  },
];

const LLM_OUTPUT = {
  summary: '本局复盘全文',
  lessons: [
    {
      title: '首日必须起跳',
      trigger: '我是预言家且首夜验出金水',
      action: '首日第一个起跳并公布金水',
      evidence: '本局压跳导致金水被误票',
      importance: 0.8,
      role: ROLES.SEER,
      scenario: 'day_speech',
      conditions: ['public_discussion'],
    },
  ],
  playerModels: [{ agentName: '阿二', content: '悍跳倾向强', confidence: 0.7 }],
};

describe('ReflectionService', () => {
  let mocks: ReturnType<typeof createMocks>;

  it('实验反思仅保存对局分析，不写入或失效记忆，也不调用 embedding', async () => {
    await mocks.service.reflect('g1', 'p1', true, false);
    expect(mocks.prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [sql, ...values] = mocks.prisma.$executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(sql.join(' ')).toContain('experimentReflection');
    expect(sql.join(' ')).toContain('reflection_generated = true');
    expect(values).toContain(JSON.stringify(LLM_OUTPUT));
    expect(mocks.memoryService.createMemories).not.toHaveBeenCalled();
    expect(mocks.memoryService.embedMemories).not.toHaveBeenCalled();
    expect(mocks.memoryService.deactivateGameMemories).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.tx.memory.updateMany).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    mocks = createMocks();
    mocks.prisma.player.findUnique.mockResolvedValue(ME);
    mocks.prisma.player.findMany.mockResolvedValue(OPPONENTS);
    mocks.prisma.agentPerformance.findUnique.mockResolvedValue({
      survivalDays: 2,
      isWinner: false,
      voteAccuracy: 0.5,
      speechCount: 3,
      reflectionGenerated: false,
    });
    mocks.prisma.decisionJudgment.findMany.mockResolvedValue([]);
    mocks.prisma.event.findMany.mockResolvedValue([]);
    mocks.prisma.agentJudgment.findMany.mockResolvedValue([]);
    mocks.prisma.memory.findMany.mockResolvedValue([]);
    mocks.structuredLlm.invoke.mockResolvedValue({ output: LLM_OUTPUT, modelName: 'test-model' });
  });

  it('按 reflection / lesson / player_model 三类写入，label 取 memoryLabelSnapshot', async () => {
    const count = await mocks.service.reflect('g1', 'p1');

    expect(count).toBe(3);
    const inputs = mocks.memoryService.createMemories.mock.calls[0][0] as CreateMemoryInput[];
    expect(inputs.map((i) => i.type)).toEqual(['reflection', 'lesson', 'player_model']);
    expect(inputs.every((i) => i.label === 'label-v1')).toBe(true);
    expect(inputs.every((i) => i.gameId === 'g1' && i.agentId === 'a1')).toBe(true);
  });

  it('lesson 正文含 trigger/action 供匹配与执行，但不含 evidence（避免座位绑定污染下一局）', async () => {
    await mocks.service.reflect('g1', 'p1');

    const inputs = mocks.memoryService.createMemories.mock.calls[0][0] as CreateMemoryInput[];
    const lesson = inputs.find((i) => i.type === 'lesson')!;
    expect(lesson.content).toContain('我是预言家且首夜验出金水');
    expect(lesson.content).toContain('首日第一个起跳并公布金水');
    expect(lesson.content).not.toContain('本局压跳导致金水被误票');
    expect(lesson.metadata).toMatchObject({
      trigger: '我是预言家且首夜验出金水',
      role: ROLES.SEER,
      scenario: 'day_speech',
      conditions: ['public_discussion'],
    });
  });

  it('player_model 带 targetAgentId，并软删除该对手的旧建模', async () => {
    await mocks.service.reflect('g1', 'p1');

    const inputs = mocks.memoryService.createMemories.mock.calls[0][0] as CreateMemoryInput[];
    expect(inputs.find((i) => i.type === 'player_model')!.metadata).toMatchObject({
      targetAgentId: 'a2',
      targetAgentName: '阿二',
    });

    const updateArgs = mocks.tx.memory.updateMany.mock.calls[0][0];
    expect(updateArgs.data).toEqual({ isActive: false });
    expect(updateArgs.where.OR).toEqual([{ metadata: { path: ['targetAgentId'], equals: 'a2' } }]);
  });

  it('丢弃不在同桌名单内的对手建模，避免模型编造 Agent', async () => {
    mocks.structuredLlm.invoke.mockResolvedValue({
      output: {
        ...LLM_OUTPUT,
        playerModels: [
          { agentName: '阿二', content: '悍跳倾向强', confidence: 0.7 },
          { agentName: '查无此人', content: '编造的', confidence: 0.9 },
        ],
      },
      modelName: 'test-model',
    });

    await mocks.service.reflect('g1', 'p1');

    const inputs = mocks.memoryService.createMemories.mock.calls[0][0] as CreateMemoryInput[];
    const models = inputs.filter((i) => i.type === 'player_model');
    expect(models).toHaveLength(1);
    expect(models[0].title).toContain('阿二');
  });

  it('已生成过反思时跳过，不再调用 LLM', async () => {
    mocks.prisma.agentPerformance.findUnique.mockResolvedValue({
      survivalDays: 2,
      isWinner: false,
      voteAccuracy: null,
      speechCount: 0,
      reflectionGenerated: true,
    });

    const count = await mocks.service.reflect('g1', 'p1');

    expect(count).toBe(0);
    expect(mocks.structuredLlm.invoke).not.toHaveBeenCalled();
    expect(mocks.memoryService.createMemories).not.toHaveBeenCalled();
  });

  it('缺少 AgentPerformance 时直接抛错交给队列重试，不消耗 LLM', async () => {
    mocks.prisma.agentPerformance.findUnique.mockResolvedValue(null);

    await expect(mocks.service.reflect('g1', 'p1')).rejects.toThrow('尚无表现记录');

    expect(mocks.gameReviewService.loadReview).not.toHaveBeenCalled();
    expect(mocks.structuredLlm.invoke).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.memoryService.createMemories).not.toHaveBeenCalled();
  });

  it('force 重跑只软删除当前标签下由反思生成的三类旧记忆', async () => {
    mocks.prisma.agentPerformance.findUnique.mockResolvedValue({
      survivalDays: 2,
      isWinner: false,
      voteAccuracy: null,
      speechCount: 0,
      reflectionGenerated: true,
    });

    await mocks.service.reflect('g1', 'p1', true);

    expect(mocks.memoryService.deactivateGameMemories).not.toHaveBeenCalled();
    expect(mocks.tx.memory.updateMany.mock.calls[0][0]).toEqual({
      where: {
        gameId: 'g1',
        agentId: 'a1',
        label: 'label-v1',
        source: 'auto',
        type: { in: ['reflection', 'lesson', 'player_model'] },
        isActive: true,
      },
      data: { isActive: false },
    });
    expect(mocks.memoryService.createMemories).toHaveBeenCalled();
  });

  it('非 force 时不触碰本局旧记忆', async () => {
    await mocks.service.reflect('g1', 'p1');

    expect(mocks.memoryService.deactivateGameMemories).not.toHaveBeenCalled();
  });

  it('写正文与置 flag 在同一事务内，embedding 在事务外补', async () => {
    await mocks.service.reflect('g1', 'p1');

    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.memoryService.createMemories.mock.calls[0][1]).toBe(mocks.tx);
    expect(mocks.tx.agentPerformance.updateMany).toHaveBeenCalledWith({
      where: { gameId: 'g1', playerId: 'p1', reflectionGenerated: false },
      data: { reflectionGenerated: true },
    });
    expect(mocks.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.memoryService.embedMemories).toHaveBeenCalledWith([
      { id: 'm0', content: '本局复盘全文' },
      { id: 'm1', content: expect.stringContaining('首日第一个起跳并公布金水') },
      { id: 'm2', content: '悍跳倾向强' },
    ]);
  });

  it('并发非 force 任务未领取到写入权时不创建重复记忆', async () => {
    mocks.tx.agentPerformance.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(mocks.service.reflect('g1', 'p1')).resolves.toBe(0);

    expect(mocks.memoryService.createMemories).not.toHaveBeenCalled();
    expect(mocks.memoryService.embedMemories).not.toHaveBeenCalled();
  });

  it('写前发现 player_model 快照已变化时，基于最新建模在事务外重新调用 LLM', async () => {
    mocks.prisma.memory.findMany
      .mockResolvedValueOnce([
        {
          id: 'pm-old',
          content: '旧建模',
          metadata: { targetAgentId: 'a2', targetAgentName: '阿二' },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'pm-new',
          content: '并发更新后建模',
          metadata: { targetAgentId: 'a2', targetAgentName: '阿二' },
        },
      ]);
    mocks.tx.memory.findMany
      .mockResolvedValueOnce([{ id: 'pm-new' }])
      .mockResolvedValueOnce([{ id: 'pm-new' }]);
    mocks.structuredLlm.invoke
      .mockResolvedValueOnce({
        output: {
          ...LLM_OUTPUT,
          playerModels: [{ agentName: '阿二', content: '基于旧快照', confidence: 0.6 }],
        },
        modelName: 'test-model',
      })
      .mockResolvedValueOnce({
        output: {
          ...LLM_OUTPUT,
          playerModels: [{ agentName: '阿二', content: '融合最新建模', confidence: 0.8 }],
        },
        modelName: 'test-model',
      });

    await expect(mocks.service.reflect('g1', 'p1')).resolves.toBe(3);

    expect(mocks.structuredLlm.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(2);
    // stale 分支在领取 flag 和任何写入之前退出。
    expect(mocks.tx.agentPerformance.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.memoryService.createMemories).toHaveBeenCalledTimes(1);

    const userPromptCalls = mocks.promptService.render.mock.calls.filter((call) => call[1]);
    expect(userPromptCalls).toHaveLength(2);
    expect(userPromptCalls[0][1].existingModels).toContain('旧建模');
    expect(userPromptCalls[1][1].existingModels).toContain('并发更新后建模');
    const inputs = mocks.memoryService.createMemories.mock.calls[0][0] as CreateMemoryInput[];
    expect(inputs.find((input) => input.type === 'player_model')?.content).toBe('融合最新建模');
  });

  it('force 重跑的快照连续冲突时抛错交给队列重试，且不领取 flag 也不软删除', async () => {
    mocks.prisma.memory.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'snapshot-2', content: '版本2', metadata: null }])
      .mockResolvedValueOnce([{ id: 'snapshot-3', content: '版本3', metadata: null }]);
    mocks.tx.memory.findMany
      .mockResolvedValueOnce([{ id: 'current-1' }])
      .mockResolvedValueOnce([{ id: 'current-2' }])
      .mockResolvedValueOnce([{ id: 'current-3' }]);

    await expect(mocks.service.reflect('g1', 'p1', true)).rejects.toThrow('连续发生并发更新');

    expect(mocks.structuredLlm.invoke).toHaveBeenCalledTimes(3);
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(mocks.tx.agentPerformance.updateMany).not.toHaveBeenCalled();
    expect(mocks.tx.memory.updateMany).not.toHaveBeenCalled();
    expect(mocks.memoryService.createMemories).not.toHaveBeenCalled();
    expect(mocks.memoryService.embedMemories).not.toHaveBeenCalled();
  });

  it('玩家不属于该对局时跳过', async () => {
    mocks.prisma.player.findUnique.mockResolvedValue({ ...ME, gameId: 'other' });

    expect(await mocks.service.reflect('g1', 'p1')).toBe(0);
    expect(mocks.structuredLlm.invoke).not.toHaveBeenCalled();
  });

  it('对局复盘缺失时抛错，避免玩家反思建立在空输入上', async () => {
    mocks.gameReviewService.loadReview.mockResolvedValue(null);

    await expect(mocks.service.reflect('g1', 'p1')).rejects.toThrow('尚无对局复盘');
  });

  it('同日多次信任判断按事件 sequence 稳定保留最后一次，并读取 relationship', async () => {
    mocks.prisma.agentJudgment.findMany.mockResolvedValue([
      {
        id: 'newer',
        speakerSeatNo: 2,
        trustScore: 10,
        suspicious: true,
        relationship: 'checked_wolf',
        createdAt: new Date('2026-01-01T00:00:01Z'),
        speechEvent: { sequence: 20 },
      },
      {
        id: 'same-event-older',
        speakerSeatNo: 2,
        trustScore: 85,
        suspicious: false,
        relationship: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        speechEvent: { sequence: 20 },
      },
      {
        id: 'older',
        speakerSeatNo: 2,
        trustScore: 90,
        suspicious: false,
        relationship: null,
        createdAt: new Date('2026-01-01T00:00:02Z'),
        speechEvent: { sequence: 10 },
      },
    ]);

    await mocks.service.reflect('g1', 'p1');

    const query = mocks.prisma.agentJudgment.findMany.mock.calls[0][0];
    expect(query.select).toMatchObject({
      relationship: true,
      createdAt: true,
      speechEvent: { select: { sequence: true } },
    });
    const variables = mocks.promptService.render.mock.calls.find((call) => call[1])?.[1];
    expect(variables.trustMisreads).toBe('（没有明显的识人偏差）');
  });

  it('玩家反思输入保留发言 phase 与 visibility', async () => {
    mocks.prisma.event.findMany.mockResolvedValue([
      {
        day: 1,
        phase: 'night',
        visibility: 'wolf',
        content: { speech: '今晚刀2号', thinking: '私下计划' },
      },
    ]);

    await mocks.service.reflect('g1', 'p1');

    const query = mocks.prisma.event.findMany.mock.calls[0][0];
    expect(query.select).toEqual({ day: true, phase: true, visibility: true, content: true });
    const variables = mocks.promptService.render.mock.calls.find((call) => call[1])?.[1];
    expect(variables.mySpeeches).toContain('第1天 [阶段=night，可见性=wolf]：今晚刀2号');
    expect(variables.mySpeeches).toContain('私下计划');
  });
});
