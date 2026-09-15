import { evaluationCompleteness } from './evaluation-completeness';
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

it.each(['decision', 'speech', 'team'])(
  '即使运行标记完成，缺少 %s 投影仍不允许消费',
  (missingId) => {
    const events = [
      { id: 'decision', actorId: 'p', actionType: 'seer_check', content: { targetSeatNo: 2 } },
      { id: 'speech', actorId: 'p', actionType: 'speech', content: { speech: '我的发言' } },
      { id: 'team', actorId: null, actionType: 'wolf_kill', content: { targetSeatNo: 2 } },
    ];
    const run = {
      id: 'run',
      status: 'complete',
      expectedEventIds: events.map((event) => event.id),
    };
    const judgments = events
      .filter((event) => event.id !== missingId)
      .map((event) => ({
        eventId: event.id,
        evaluationRunId: run.id,
        evaluationVersion: EVALUATION_VERSION,
      }));
    expect(evaluationCompleteness({ run, events, judgments })).toMatchObject({
      complete: false,
      missing: [missingId],
    });
  },
);
