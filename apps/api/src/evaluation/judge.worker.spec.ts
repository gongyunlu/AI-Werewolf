import type { Job } from 'bullmq';
import type { JudgeService } from './judge.service';
import { JUDGE_JOB_NAMES, type JudgeJobData } from './judge-queue.service';
import { JudgeWorkerService } from './judge.worker';

describe('JudgeWorkerService', () => {
  it('completion 任务严格回填 reward，不再重复执行评分', async () => {
    const judge = {
      backfillRewards: jest.fn().mockResolvedValue(3),
      aggregatePlayerScores: jest.fn().mockResolvedValue(undefined),
      judgeEvent: jest.fn(),
      judgeSpeeches: jest.fn(),
    };
    const worker = new JudgeWorkerService(judge as unknown as JudgeService);
    const job = {
      id: 'complete-1',
      name: JUDGE_JOB_NAMES.complete,
      data: { gameId: 'game-1' },
    } as Job<JudgeJobData>;

    await expect(worker.process(job)).resolves.toBeUndefined();

    expect(judge.backfillRewards).toHaveBeenCalledWith('game-1');
    expect(judge.aggregatePlayerScores).toHaveBeenCalledWith('game-1');
    expect(judge.judgeEvent).not.toHaveBeenCalled();
    expect(judge.judgeSpeeches).not.toHaveBeenCalled();
  });

  it('completion 回填失败时向上抛出，让 BullMQ 重试', async () => {
    const judge = {
      backfillRewards: jest.fn().mockRejectedValue(new Error('db unavailable')),
      aggregatePlayerScores: jest.fn().mockResolvedValue(undefined),
      judgeEvent: jest.fn(),
      judgeSpeeches: jest.fn(),
    };
    const worker = new JudgeWorkerService(judge as unknown as JudgeService);
    const job = {
      id: 'complete-1',
      name: JUDGE_JOB_NAMES.complete,
      data: { gameId: 'game-1' },
    } as Job<JudgeJobData>;

    await expect(worker.process(job)).rejects.toThrow('db unavailable');
  });
});
