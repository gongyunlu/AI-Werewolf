import { EVALUATION_VERSION } from './evaluation-version';
import { evaluationCompleteness } from './evaluation-completeness';
import { summarizeObservations, type ScoredObservation } from './ab-statistics';

const events = [
  { id: 'decision', actorId: 'p', actionType: 'seer_check', content: { targetSeatNo: 2 } },
  { id: 'speech', actorId: 'p', actionType: 'speech', content: { speech: '证据' } },
  { id: 'team', actorId: null, actionType: 'wolf_kill', content: { targetSeatNo: 3 } },
  { id: 'blank', actorId: 'p', actionType: 'speech', content: { speech: ' ' } },
  { id: 'orphan', actorId: null, actionType: 'speech', content: { speech: '无玩家' } },
];
const expectedEventIds = ['decision', 'speech', 'team'];
const run = { id: 'new-run', status: 'complete', expectedEventIds };
const judgments = expectedEventIds.map((eventId) => ({
  eventId,
  evaluationRunId: run.id,
  evaluationVersion: EVALUATION_VERSION,
}));

it('非空发言、个人决策及团队狼刀均完整落库才接受，忽略空发言和孤儿发言', () => {
  expect(evaluationCompleteness({ run, events, judgments })).toEqual({
    complete: true,
    missing: [],
    reasons: [],
  });
});

it.each(['pending', 'missing', 'stale', 'old-version', 'target-mismatch', 'no-run'])(
  '拒绝评分进度异常：%s',
  (kind) => {
    const result = evaluationCompleteness({
      run:
        kind === 'no-run'
          ? null
          : {
              ...run,
              status: kind === 'pending' ? 'pending' : 'complete',
              expectedEventIds: kind === 'target-mismatch' ? ['decision'] : expectedEventIds,
            },
      events,
      judgments:
        kind === 'missing'
          ? judgments.slice(0, 2)
          : judgments.map((j) =>
              Object.assign({}, j, {
                evaluationRunId: kind === 'stale' ? 'old-run' : j.evaluationRunId,
                evaluationVersion:
                  kind === 'old-version' ? EVALUATION_VERSION - 1 : EVALUATION_VERSION,
              }),
            ),
    });
    expect(result.complete).toBe(false);
    if (kind === 'missing') expect(result.missing).toEqual(['team']);
  },
);

it('已有两臂分数，但一臂未完成或完成度未知时不能计算配对差', () => {
  const row = {
    pairId: 'pair',
    score: 80,
    actionType: 'seer_check',
    role: 'seer',
    faction: 'villager',
    model: 'm',
    visibility: 'seer',
    evaluationVersion: EVALUATION_VERSION,
  };
  for (const evaluationComplete of [false, undefined]) {
    const rows: ScoredObservation[] = [
      { ...row, gameId: 'on', arm: 'on', evaluationComplete: true },
      { ...row, gameId: 'off', arm: 'off', evaluationComplete },
    ];
    expect(summarizeObservations(rows).pairs).toEqual([]);
  }
});
