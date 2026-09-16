import type { PrismaService } from '../prisma/prisma.service';
import type { PromptService } from '../observability/prompt.service';
import type { ModelGenerationService } from '../llm/model-generation.service';
import { GameReviewService } from './game-review.service';
import { EVALUATION_VERSION } from '../evaluation/evaluation-version';

function platformReview(status = 'complete') {
  const prisma = {
    evaluationRun: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'new-run', status, definition: {}, expectedEventIds: [] }),
    },
    $executeRaw: jest.fn(),
    $transaction: jest.fn(),
    player: { findMany: jest.fn().mockResolvedValue([]) },
    gameSummary: {
      findUnique: jest.fn().mockResolvedValue({ winnerFaction: 'villager', totalDays: 1 }),
      update: jest.fn(),
    },
    event: { findMany: jest.fn().mockResolvedValue([]) },
    speechSummary: { findMany: jest.fn().mockResolvedValue([]) },
    decisionJudgment: { findMany: jest.fn().mockResolvedValue([]) },
    teamJudgment: { findMany: jest.fn().mockResolvedValue([]) },
  };
  prisma.$transaction.mockImplementation((cb) => cb(prisma));
  const llm = {
    invoke: jest
      .fn()
      .mockResolvedValue({ output: { narrative: '新复盘', patterns: [], turningPoints: [] } }),
  };
  const service = new GameReviewService(
    prisma as unknown as PrismaService,
    { render: jest.fn().mockResolvedValue({ text: 'test' }) } as unknown as PromptService,
    llm as unknown as ModelGenerationService,
  );
  return { prisma, llm, service };
}

describe('GameReviewService.loadReview', () => {
  it('历史 narrative JSON 损坏时按缺失处理，不让状态查询直接崩溃', async () => {
    const prisma = {
      evaluationRun: { findFirst: jest.fn().mockResolvedValue(null) },
      gameSummary: { findUnique: jest.fn().mockResolvedValue({ narrative: '{broken' }) },
    };
    const service = new GameReviewService(
      prisma as unknown as PrismaService,
      {} as PromptService,
      {} as ModelGenerationService,
    );

    await expect(service.loadReview('g1')).resolves.toBeNull();
  });

  it('生成复盘只读取当前版本的 judge 信号', async () => {
    const prisma = {
      evaluationRun: { findFirst: jest.fn().mockResolvedValue(null) },
      $executeRaw: jest.fn(),
      $transaction: jest.fn(),
      player: { findMany: jest.fn().mockResolvedValue([]) },
      gameSummary: {
        findUnique: jest.fn().mockResolvedValue({ winnerFaction: 'villager', totalDays: 1 }),
        update: jest.fn(),
      },
      event: { findMany: jest.fn().mockResolvedValue([]) },
      speechSummary: { findMany: jest.fn().mockResolvedValue([]) },
      decisionJudgment: { findMany: jest.fn().mockResolvedValue([]) },
    };
    prisma.$transaction.mockImplementation((cb) => cb(prisma));
    const service = new GameReviewService(
      prisma as unknown as PrismaService,
      { render: jest.fn().mockResolvedValue({ text: 'test' }) } as unknown as PromptService,
      {
        invoke: jest
          .fn()
          .mockResolvedValue({ output: { narrative: '复盘', patterns: [], turningPoints: [] } }),
      } as unknown as ModelGenerationService,
    );
    await service.reviewGame('g1', true);
    expect(prisma.decisionJudgment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { gameId: 'g1', evaluationVersion: EVALUATION_VERSION },
      }),
    );
  });

  it.each([null, 'old-run'])(
    '新平台评分采用后不复用缺少当前引用的旧复盘（原引用=%s）',
    async (oldRunId) => {
      const prisma = {
        evaluationRun: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 'new-run', status: 'complete', definition: {} }),
        },
        gameSummary: {
          findUnique: jest.fn().mockResolvedValue({
            narrative: JSON.stringify({
              narrative: '旧复盘',
              patterns: [],
              turningPoints: [],
              evaluationRunId: oldRunId,
            }),
          }),
        },
      };
      const service = new GameReviewService(
        prisma as unknown as PrismaService,
        {} as PromptService,
        {} as ModelGenerationService,
      );
      await expect(service.loadReview('g1')).resolves.toBeNull();
    },
  );

  it.each([null, 'old-run'])(
    '原始读取不受评分运行变化影响，复盘生成后的规律晋升仍取得到聚类（原引用=%s）',
    async (oldRunId) => {
      const output = { narrative: '旧复盘', patterns: [], turningPoints: [] };
      const prisma = {
        evaluationRun: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 'new-run', status: 'complete', definition: {} }),
        },
        gameSummary: {
          findUnique: jest.fn().mockResolvedValue({
            narrative: JSON.stringify({ ...output, evaluationRunId: oldRunId }),
          }),
        },
      };
      const service = new GameReviewService(
        prisma as unknown as PrismaService,
        {} as PromptService,
        {} as ModelGenerationService,
      );
      await expect(service.loadStoredReview('g1')).resolves.toEqual(output);
    },
  );

  it('原生复盘解析仅返回领域字段，不把引用混入模型输入', async () => {
    const output = { narrative: '当前复盘', patterns: [], turningPoints: [] };
    const prisma = {
      evaluationRun: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'new-run', status: 'complete', definition: {} }),
      },
      gameSummary: {
        findUnique: jest.fn().mockResolvedValue({
          narrative: JSON.stringify({ ...output, evaluationRunId: 'new-run' }),
        }),
      },
    };
    const service = new GameReviewService(
      prisma as unknown as PrismaService,
      {} as PromptService,
      {} as ModelGenerationService,
    );
    await expect(service.loadReview('g1')).resolves.toEqual(output);
  });

  it('生成复盘固定完整业务投影的评分运行并保存引用', async () => {
    const { prisma, service } = platformReview();
    await service.reviewGame('g1', true);
    expect(prisma.decisionJudgment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { gameId: 'g1', evaluationVersion: EVALUATION_VERSION, evaluationRunId: 'new-run' },
      }),
    );
    expect(JSON.parse(prisma.gameSummary.update.mock.calls[0][0].data.narrative)).toMatchObject({
      narrative: '新复盘',
      evaluationRunId: 'new-run',
    });
  });

  it.each(['pending', 'complete'])(
    '平台运行未采用或业务投影缺失时拒绝复盘（状态=%s）',
    async (status) => {
      const { prisma, llm, service } = platformReview(status);
      prisma.evaluationRun.findFirst.mockResolvedValue({
        id: 'new-run',
        status,
        definition: {},
        expectedEventIds: ['e1'],
      });
      prisma.event.findMany.mockResolvedValue([
        { id: 'e1', actorId: 'p1', actionType: 'speech', content: { speech: '发言' } },
      ]);
      await expect(service.reviewGame('g1', true)).rejects.toThrow(/尚未完整采用|业务投影不完整/);
      expect(llm.invoke).not.toHaveBeenCalled();
      expect(prisma.gameSummary.update).not.toHaveBeenCalled();
    },
  );

  it('模型生成期间采用版本改变时保留旧复盘，不提交过时结果', async () => {
    const { prisma, llm, service } = platformReview();
    llm.invoke.mockImplementation(async () => {
      prisma.evaluationRun.findFirst.mockResolvedValue({
        id: 'next-run',
        status: 'complete',
        definition: {},
        expectedEventIds: [],
      });
      return { output: { narrative: '过时复盘', patterns: [], turningPoints: [] } };
    });
    await expect(service.reviewGame('g1', true)).rejects.toThrow('评分采用版本已更改');
    expect(prisma.gameSummary.update).not.toHaveBeenCalled();
  });
});
