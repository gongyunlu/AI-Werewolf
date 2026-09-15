import type { Job } from 'bullmq';
import type { JudgeService } from './judge.service';
import { JUDGE_JOB_NAMES, type JudgeJobData } from './judge-queue.service';
import { JudgeWorkerService } from './judge.worker';

describe('JudgeWorkerService', () => {
  it('completion 先采用完整平台评分，再聚合个人分，不重复执行评分', async () => {
    const judge = {
      completeEvaluation: jest.fn().mockResolvedValue(undefined),
      backfillRewards: jest.fn().mockResolvedValue(3),
      aggregatePlayerScores: jest.fn().mockResolvedValue(undefined),
      judgeEvent: jest.fn(),
      judgeSpeeches: jest.fn(),
    };
    const worker = new JudgeWorkerService(judge as unknown as JudgeService);
    const job = {
      id: 'complete-1',
      name: JUDGE_JOB_NAMES.complete,
      data: { gameId: 'game-1', runId: 'original-run' },
    } as Job<JudgeJobData>;

    await expect(worker.process(job)).resolves.toBeUndefined();

    expect(judge.completeEvaluation).toHaveBeenCalledWith('game-1', 'original-run');
    expect(judge.completeEvaluation.mock.invocationCallOrder[0]).toBeLessThan(
      judge.aggregatePlayerScores.mock.invocationCallOrder[0],
    );
    expect(judge.aggregatePlayerScores).toHaveBeenCalledWith('game-1');
    // reward 回填在 completion 事务内完成，worker 不再重复调用一次。
    expect(judge.backfillRewards).not.toHaveBeenCalled();
    expect(judge.judgeEvent).not.toHaveBeenCalled();
    expect(judge.judgeSpeeches).not.toHaveBeenCalled();
  });

  it('completion 采用失败时向上抛出，让 BullMQ 重试', async () => {
    const judge = {
      completeEvaluation: jest.fn().mockRejectedValue(new Error('db unavailable')),
      backfillRewards: jest.fn(),
      aggregatePlayerScores: jest.fn().mockResolvedValue(undefined),
      judgeEvent: jest.fn(),
      judgeSpeeches: jest.fn(),
    };
    const worker = new JudgeWorkerService(judge as unknown as JudgeService);
    const job = {
      id: 'complete-1',
      name: JUDGE_JOB_NAMES.complete,
      data: { gameId: 'game-1', runId: 'original-run' },
    } as Job<JudgeJobData>;

    await expect(worker.process(job)).rejects.toThrow('db unavailable');
    expect(judge.aggregatePlayerScores).not.toHaveBeenCalled();
  });

  it('平台评分尚未完整采用时阻止聚合，恢复后仅重试 completion', async () => {
    const judge = {
      completeEvaluation: jest
        .fn()
        .mockRejectedValueOnce(new Error('平台评分尚未完整可见'))
        .mockResolvedValue(undefined),
      backfillRewards: jest.fn(),
      aggregatePlayerScores: jest.fn(),
      judgeEvent: jest.fn(),
      judgeSpeeches: jest.fn(),
    };
    const worker = new JudgeWorkerService(judge as unknown as JudgeService);
    const job = {
      id: 'completion-retry',
      name: JUDGE_JOB_NAMES.complete,
      data: { gameId: 'game-1', runId: 'original-run' },
    } as Job<JudgeJobData>;

    await expect(worker.process(job)).rejects.toThrow('平台评分尚未完整可见');
    expect(judge.aggregatePlayerScores).not.toHaveBeenCalled();
    await expect(worker.process(job)).resolves.toBeUndefined();
    expect(judge.completeEvaluation).toHaveBeenCalledTimes(2);
    expect(judge.aggregatePlayerScores).toHaveBeenCalledTimes(1);
    expect(judge.judgeEvent).not.toHaveBeenCalled();
    expect(judge.judgeSpeeches).not.toHaveBeenCalled();
  });
});
