import type { Job } from 'bullmq';
import type { JudgeService } from './judge.service';
import { JUDGE_JOB_NAMES, type JudgeJobData } from './judge-queue.service';
import { JudgeWorkerService } from './judge.worker';

describe('JudgeWorkerService', () => {
  it('completion 通过同一采用入口提交本地评分，不重复执行评分', async () => {
    const judge = {
      completeEvaluation: jest.fn().mockResolvedValue(undefined),
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
    expect(judge.judgeEvent).not.toHaveBeenCalled();
    expect(judge.judgeSpeeches).not.toHaveBeenCalled();
  });

  it('completion 采用失败时向上抛出，让 BullMQ 重试', async () => {
    const judge = {
      completeEvaluation: jest.fn().mockRejectedValue(new Error('db unavailable')),
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
  });

  it('显式采用的平台评分尚不可见时阻止聚合，恢复后仅重试 completion', async () => {
    const judge = {
      completeEvaluation: jest
        .fn()
        .mockRejectedValueOnce(new Error('平台评分尚未完整可见'))
        .mockResolvedValue(undefined),
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
    await expect(worker.process(job)).resolves.toBeUndefined();
    expect(judge.completeEvaluation).toHaveBeenCalledTimes(2);
    expect(judge.judgeEvent).not.toHaveBeenCalled();
    expect(judge.judgeSpeeches).not.toHaveBeenCalled();
  });
});
