import type { PrismaService } from '../prisma/prisma.service';
import type { PromptService } from '../observability/prompt.service';
import type { StructuredLlmService } from '../observability/structured-llm.service';
import { GameReviewService } from './game-review.service';

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
});
