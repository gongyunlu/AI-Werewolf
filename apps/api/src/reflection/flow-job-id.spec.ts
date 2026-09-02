import { JudgeQueueService } from '../evaluation/judge-queue.service';
import { JudgeService } from '../evaluation/judge.service';
import { PrismaService } from '../prisma/prisma.service';
import { buildReviewJobId } from './reflection-queue.service';
import type { Queue } from 'bullmq';

/**
 * 锁死 BullMQ FlowProducer 的 jobId 约束：不得含冒号。
 *
 * 普通 queue.add 不校验，只有走 flow 时才在 Job.validateOptions 抛
 * 「Custom Id cannot contain :」，因此单测与启动烟雾验证都抓不到，
 * 只能在真实投递时炸。这里直接断言 flow 里用到的两类 jobId。
 */
describe('flow jobId 不得含冒号', () => {
  const SUFFIX = '_run_1756300000000';
  const GAME_ID = '8fc39edb-4188-4415-b5ef-5ef0379162f4';

  it('父任务 jobId（复盘）', () => {
    expect(buildReviewJobId(GAME_ID)).not.toContain(':');
    expect(buildReviewJobId(GAME_ID, SUFFIX)).not.toContain(':');
  });

  it('子任务 jobId（决策逐条评 + 发言按玩家批量评）', async () => {
    const judgeService = {
      findJudgeableEvents: jest.fn().mockResolvedValue(['e1', 'e2']),
      findSpeakingPlayers: jest.fn().mockResolvedValue(['p1', 'p2']),
    };
    const service = new JudgeQueueService(
      {} as unknown as Queue,
      judgeService as unknown as JudgeService,
      {} as unknown as PrismaService,
      {} as never,
    );

    const jobs = await service.listGameJobs(GAME_ID, SUFFIX);

    expect(jobs).toHaveLength(4);
    for (const job of jobs) {
      expect(job.jobId).not.toContain(':');
    }
  });

  it('重跑后缀不引入冒号，且同一目标两次重跑的 jobId 不同', async () => {
    const judgeService = {
      findJudgeableEvents: jest.fn().mockResolvedValue(['e1']),
      findSpeakingPlayers: jest.fn().mockResolvedValue([]),
    };
    const service = new JudgeQueueService(
      {} as unknown as Queue,
      judgeService as unknown as JudgeService,
      {} as unknown as PrismaService,
      {} as never,
    );

    const [plain] = await service.listGameJobs(GAME_ID);
    const [rerun] = await service.listGameJobs(GAME_ID, SUFFIX);

    expect(plain.jobId).toBe('e1');
    expect(rerun.jobId).not.toBe(plain.jobId);
    expect(rerun.jobId).not.toContain(':');
  });
});
