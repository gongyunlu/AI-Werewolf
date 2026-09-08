import type { PrismaService } from '../prisma/prisma.service';
import type { PromptService } from '../observability/prompt.service';
import type { StructuredLlmService } from '../observability/structured-llm.service';
import { GameReviewService } from './game-review.service';
import { EVALUATION_VERSION } from '../evaluation/evaluation-version';

describe('GameReviewService.loadReview', () => {
  it('历史 narrative JSON 损坏时按缺失处理，不让状态查询直接崩溃', async () => {
    const prisma = {
      gameSummary: { findUnique: jest.fn().mockResolvedValue({ narrative: '{broken' }) },
    };
    const service = new GameReviewService(
      prisma as unknown as PrismaService,
      {} as PromptService,
      {} as StructuredLlmService,
    );

    await expect(service.loadReview('g1')).resolves.toBeNull();
  });

  it('生成复盘只读取当前版本的 judge 信号', async () => {
    const prisma = {
      player: { findMany: jest.fn().mockResolvedValue([]) },
      gameSummary: {
        findUnique: jest.fn().mockResolvedValue({ winnerFaction: 'villager', totalDays: 1 }),
        update: jest.fn(),
      },
      event: { findMany: jest.fn().mockResolvedValue([]) },
      speechSummary: { findMany: jest.fn().mockResolvedValue([]) },
      decisionJudgment: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new GameReviewService(
      prisma as unknown as PrismaService,
      { render: jest.fn().mockResolvedValue({ text: 'test' }) } as unknown as PromptService,
      {
        invoke: jest
          .fn()
          .mockResolvedValue({ output: { narrative: '复盘', patterns: [], turningPoints: [] } }),
      } as unknown as StructuredLlmService,
    );
    await service.reviewGame('g1', true);
    expect(prisma.decisionJudgment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { gameId: 'g1', evaluationVersion: EVALUATION_VERSION },
      }),
    );
  });
});
