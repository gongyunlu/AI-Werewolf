import type { FlowProducer, Queue } from 'bullmq';
import type { PrismaService } from '../prisma/prisma.service';
import type { JudgeService } from './judge.service';
import {
  JUDGE_JOB_NAMES,
  JUDGE_QUEUE_NAME,
  JudgeQueueService,
  buildJudgeCompleteJobId,
} from './judge-queue.service';

const GAME_ID = '00000000-0000-4000-8000-000000000001';

function createHarness() {
  const queue = { add: jest.fn(), getJobs: jest.fn(), getJob: jest.fn() };
  const judge = {
    beginEvaluation: jest.fn(),
    resolveEvaluationRun: jest.fn(async (_gameId, proposedRunId) => proposedRunId),
    findJudgeableEvents: jest.fn().mockResolvedValue(['event-1']),
    findSpeakingPlayers: jest.fn().mockResolvedValue(['player-1']),
  };
  const flowProducer = { add: jest.fn().mockResolvedValue(undefined) };
  const service = new JudgeQueueService(
    queue as unknown as Queue,
    judge as unknown as JudgeService,
    {} as unknown as PrismaService,
    flowProducer as unknown as FlowProducer,
  );
  return { service, queue, judge, flowProducer };
}

describe('JudgeQueueService', () => {
  it('judge-only 使用 completion flow，并让任一评分最终失败传播到 completion', async () => {
    const { service, flowProducer } = createHarness();

    await expect(service.enqueueGame(GAME_ID)).resolves.toBe(2);

    expect(flowProducer.add).toHaveBeenCalledWith(
      expect.objectContaining({
        name: JUDGE_JOB_NAMES.complete,
        queueName: JUDGE_QUEUE_NAME,
        data: expect.objectContaining({ gameId: GAME_ID, runId: `${GAME_ID}_initial` }),
        opts: expect.objectContaining({ jobId: buildJudgeCompleteJobId(GAME_ID) }),
        children: [
          expect.objectContaining({
            name: JUDGE_JOB_NAMES.decision,
            opts: expect.objectContaining({ failParentOnFailure: true }),
          }),
          expect.objectContaining({
            name: JUDGE_JOB_NAMES.speeches,
            opts: expect.objectContaining({ failParentOnFailure: true }),
          }),
        ],
      }),
    );
  });

  it('没有评分目标时仍投递 completion，以刷新历史 reward', async () => {
    const { service, queue, judge, flowProducer } = createHarness();
    judge.findJudgeableEvents.mockResolvedValue([]);
    judge.findSpeakingPlayers.mockResolvedValue([]);
    queue.add.mockResolvedValue(undefined);

    await expect(service.enqueueGame(GAME_ID)).resolves.toBe(0);

    expect(flowProducer.add).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      JUDGE_JOB_NAMES.complete,
      { gameId: GAME_ID, runId: `${GAME_ID}_initial` },
      expect.objectContaining({ jobId: buildJudgeCompleteJobId(GAME_ID) }),
    );
  });

  it('恢复交付只替换队列 jobId，全部子任务和 completion 继续使用原评分运行', async () => {
    const { service, judge, flowProducer } = createHarness();
    judge.resolveEvaluationRun.mockResolvedValue('original-run');

    await service.enqueueGame(GAME_ID, '_resume_123');

    expect(judge.resolveEvaluationRun).toHaveBeenCalledWith(GAME_ID, `${GAME_ID}_resume_123`, true);
    expect(judge.beginEvaluation).toHaveBeenCalledWith(GAME_ID, 'original-run');
    const flow = flowProducer.add.mock.calls[0][0];
    expect(flow.data.runId).toBe('original-run');
    expect(flow.opts.jobId).toBe(buildJudgeCompleteJobId(GAME_ID, '_resume_123'));
    expect(
      flow.children.every(
        (job: { data: { runId: string }; opts: { jobId: string } }) =>
          job.data.runId === 'original-run' && job.opts.jobId.endsWith('_resume_123'),
      ),
    ).toBe(true);
  });

  it('扫描整个 judge queue 识别同局任一在途任务', async () => {
    const { service, queue } = createHarness();
    queue.getJobs.mockResolvedValue([
      { name: JUDGE_JOB_NAMES.decision, data: { gameId: 'other' } },
      { name: JUDGE_JOB_NAMES.complete, data: { gameId: GAME_ID } },
    ]);

    await expect(service.hasInFlightGame(GAME_ID)).resolves.toBe(true);
    expect(queue.getJobs).toHaveBeenCalledWith(
      ['active', 'waiting', 'waiting-children', 'delayed', 'prioritized'],
      0,
      -1,
      true,
    );
  });

  it('读取稳定 completion 终态，供恢复批次避免复用旧 child parent', async () => {
    const { service, queue } = createHarness();
    queue.getJob.mockResolvedValue({ getState: jest.fn().mockResolvedValue('failed') });

    await expect(service.getCompletionState(GAME_ID)).resolves.toBe('failed');
    expect(queue.getJob).toHaveBeenCalledWith(buildJudgeCompleteJobId(GAME_ID));
  });
});
