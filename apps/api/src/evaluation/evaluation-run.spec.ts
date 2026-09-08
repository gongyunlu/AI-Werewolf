import { EVALUATION_VERSION } from './evaluation-version';
import { JudgeService } from './judge.service';

it.each(['complete', 'stale', 'pending', 'target-mismatch', 'legacy'])(
  '分析进度按同一批次逐事件核对，不用历史评分总数推断完成：%s',
  async (mode) => {
    const expected = ['decision', 'team'];
    const run =
      mode === 'legacy'
        ? null
        : {
            id: 'run',
            gameId: 'g',
            status: mode === 'pending' ? 'pending' : 'complete',
            expectedEventIds: mode === 'target-mismatch' ? ['decision'] : expected,
          };
    const judgments = [
      {
        eventId: 'decision',
        evaluationRunId: mode === 'stale' ? 'old-run' : 'run',
        evaluationVersion: EVALUATION_VERSION,
      },
      { eventId: 'unrelated', evaluationRunId: 'run', evaluationVersion: EVALUATION_VERSION },
    ];
    const team = [
      { eventId: 'team', evaluationRunId: 'run', evaluationVersion: EVALUATION_VERSION },
    ];
    const events = [
      { id: 'decision', actorId: 'p', actionType: 'seer_check', content: { targetSeatNo: 2 } },
      { id: 'team', actorId: null, actionType: 'wolf_kill', content: { targetSeatNo: 2 } },
    ];
    const db = {
      evaluationRun: { findFirst: jest.fn().mockResolvedValue(run) },
      event: { findMany: jest.fn().mockResolvedValue(events) },
      decisionJudgment: { findMany: jest.fn().mockResolvedValue(judgments) },
      teamJudgment: { findMany: jest.fn().mockResolvedValue(team) },
    };
    const prisma = { $transaction: jest.fn(async (task) => task(db)) };
    const service = new JudgeService(
      ...([prisma, {}, {}] as unknown as ConstructorParameters<typeof JudgeService>),
    );
    expect(await service.getEvaluationProgress('g')).toEqual({
      runId: run?.id,
      complete: mode === 'complete' || mode === 'legacy',
      judgeableCount: 2,
      judgedCount: mode === 'stale' ? 1 : 2,
    });
  },
);

it('登记目标清单后，团队分或个人分缺失均不能标记批次完成', async () => {
  const run = { id: 'run', gameId: 'g', expectedEventIds: ['decision', 'speech', 'team'] };
  const prisma = {
    game: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ status: 'finished', experiment: null }),
    },
    evaluationRun: {
      upsert: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue(run),
      update: jest.fn(),
    },
    decisionJudgment: {
      findMany: jest.fn().mockResolvedValue([{ eventId: 'decision' }, { eventId: 'speech' }]),
    },
    teamJudgment: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const service = new JudgeService(
    ...([prisma, {}, {}] as unknown as ConstructorParameters<typeof JudgeService>),
  );
  jest.spyOn(service, 'findJudgeableEvents').mockResolvedValue(['decision', 'team']);
  jest.spyOn(service, 'findSpeechesToJudge').mockResolvedValue(['speech']);
  await service.beginEvaluation('g', 'run');
  expect(prisma.evaluationRun.upsert.mock.calls[0][0].create.expectedEventIds.toSorted()).toEqual(
    run.expectedEventIds.toSorted(),
  );
  await expect(service.completeEvaluation('g', 'run')).rejects.toThrow('尚未完整');
  expect(prisma.evaluationRun.update).not.toHaveBeenCalled();
  prisma.teamJudgment.findMany.mockResolvedValue([{ eventId: 'team' }]);
  await service.completeEvaluation('g', 'run');
  expect(prisma.decisionJudgment.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { gameId: 'g', evaluationRunId: 'run', evaluationVersion: EVALUATION_VERSION },
    }),
  );
  expect(prisma.evaluationRun.update).toHaveBeenCalledWith({
    where: { id: 'run' },
    data: { status: 'complete', completedAt: expect.any(Date) },
  });
});
