import {
  summarizeObservations,
  stratifyObservations,
  summarizeAgentRolePairs,
  type ScoredObservation,
} from './ab-statistics';
import { EVALUATION_VERSION } from './evaluation-version';

const row = (gameId: string, arm: ScoredObservation['arm'], score: number): ScoredObservation => ({
  gameId,
  agentId: 'agent',
  arm,
  score,
  role: 'seer',
  faction: 'villager',
  model: 'model',
  actionType: 'seer_check',
  visibility: 'seer',
  evaluationVersion: EVALUATION_VERSION,
  evaluationComplete: true,
});

it('同角色同模型的不同 agent 不互相配对，缺一侧不补零', () => {
  const report = summarizeAgentRolePairs([
    { ...row('on', 'on', 90), pairId: 'p', agentId: 'a' },
    { ...row('off', 'off', 10), pairId: 'p', agentId: 'b' },
  ])[0];
  expect(report.completePairs).toBe(0);
  expect(report.pairedMeanDifference).toBeNull();
  expect(report.unmatched).toHaveLength(2);
  expect(report.on).toEqual({ scoredEvents: 1, scoredGames: 1, matchedEvents: 0, matchedGames: 0 });
});

it('两臂动作次数不同不改变 agent 权重，消除只由组成产生的均分差', () => {
  const rows = [
    ...Array.from({ length: 9 }, () => ({ ...row('on', 'on', 100), pairId: 'p', agentId: 'a' })),
    { ...row('off', 'off', 100), pairId: 'p', agentId: 'a' },
    { ...row('on', 'on', 0), pairId: 'p', agentId: 'b' },
    ...Array.from({ length: 9 }, () => ({ ...row('off', 'off', 0), pairId: 'p', agentId: 'b' })),
  ];
  expect(summarizeObservations(rows).pairedMeanDifference).toBe(80);
  const report = summarizeAgentRolePairs(rows)[0];
  expect(report.pairedMeanDifference).toBe(0);
  expect(report.matchedAgentPairs).toBe(2);
  expect(report.completePairs).toBe(1);
  expect(report.on.matchedEvents).toBe(10);
  expect(report.perPair[0].onMean).toBe(50);
  expect(report.perPair[0].offMean).toBe(50);
});

it('对局配对等权，匹配 agent 更多的一对不会成为更多独立样本', () => {
  const rows = [
    ...['a', 'b'].flatMap((agentId) => [
      { ...row('on1', 'on', 100), pairId: 'p1', agentId },
      { ...row('off1', 'off', 0), pairId: 'p1', agentId },
    ]),
    { ...row('on2', 'on', 0), pairId: 'p2', agentId: 'a' },
    { ...row('off2', 'off', 100), pairId: 'p2', agentId: 'a' },
  ];
  const report = summarizeAgentRolePairs(rows)[0];
  expect(report.pairedMeanDifference).toBe(0);
  expect(report.completePairs).toBe(2);
  expect(report.matchedAgentPairs).toBe(3);
  expect(report.on.matchedGames).toBe(2);
});

it.each([
  { model: 'other-model' },
  { role: 'witch' },
  { actionType: 'vote' },
  { evaluationVersion: EVALUATION_VERSION - 1 },
  { visibility: 'public' },
  { pairId: 'other-pair' },
])('不跨模型、角色、动作、评分版本、可见性或配对混算：%j', (mismatch) => {
  const report = summarizeAgentRolePairs([
    { ...row('on', 'on', 90), pairId: 'p' },
    { ...row('off', 'off', 10), pairId: 'p', ...mismatch },
  ]);
  expect(
    report.every((stratum) => stratum.completePairs === 0 && stratum.pairedMeanDifference === null),
  ).toBe(true);
});

it('无 agent 身份、无配对、未知分组及未完成评分不会生成个人配对结果', () => {
  expect(
    summarizeAgentRolePairs([
      { ...row('on', 'on', 90), pairId: 'p', agentId: undefined },
      row('off', 'off', 10),
      { ...row('unknown', 'unknown', 10), pairId: 'p' },
      { ...row('pending', 'on', 10), pairId: 'p', evaluationComplete: false },
      { ...row('legacy', 'off', 10), pairId: 'p', evaluationComplete: undefined },
    ]),
  ).toEqual([]);
});

it('局等权避免长局占更多权重，未知开关不会混入 OFF', () => {
  const summary = summarizeObservations([
    row('a', 'on', 100),
    row('b', 'on', 0),
    row('b', 'on', 0),
    row('c', 'off', 40),
    row('d', 'unknown', 0),
  ]);
  expect(summary.on.eventMean).toBeCloseTo(100 / 3);
  expect(summary.on.gameMean).toBe(50);
  expect(summary.gameMeanDifference).toBe(10);
  expect(summary.off.n).toBe(1);
  expect(summary.unknown.games).toBe(1);
});

it('只计算双方都有评分的配对，且版本、动作和角色分层', () => {
  const rows = [
    { ...row('a', 'on', 80), pairId: 'pair' },
    { ...row('b', 'off', 50), pairId: 'pair' },
    { ...row('c', 'on', 100), pairId: 'incomplete' },
  ];
  expect(summarizeObservations(rows).pairedMeanDifference).toBe(30);
  expect(summarizeObservations(rows).pairs).toHaveLength(1);
  expect(
    Object.keys(
      stratifyObservations([
        ...rows,
        { ...row('d', 'on', 90), evaluationVersion: EVALUATION_VERSION - 1 },
      ]),
    ),
  ).toHaveLength(2);
});
