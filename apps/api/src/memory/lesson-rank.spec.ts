import { computeLessonCandidateScore, computeLessonRank } from './lesson-rank';

const baseline = new Map([
  ['vote', 60],
  ['speech', 80],
]);

describe('computeLessonRank', () => {
  it('无命中样本时退回 importance 先验（×100 拉到分数量纲）', () => {
    expect(
      computeLessonRank({
        hits: [],
        baselineByActionType: baseline,
        defaultBaseline: 70,
        totalHits: 100,
        importance: 0.5,
      }),
    ).toBe(50);
  });

  it('lift = 命中 reward 相对同 actionType 基线的平均差', () => {
    const rank = computeLessonRank({
      hits: [
        { actionType: 'vote', reward: 70 },
        { actionType: 'vote', reward: 80 },
      ],
      baselineByActionType: baseline,
      defaultBaseline: 70,
      totalHits: 100,
      importance: 0.5,
      c: 0, // 关掉探索项，只看 quality
    });
    // lift = (10 + 20) / 2 = 15，quality = 15 × 2/(2+5)
    expect(rank).toBeCloseTo(15 * (2 / 7));
  });

  it('未登记 actionType 用 defaultBaseline 兜底', () => {
    const rank = computeLessonRank({
      hits: [{ actionType: 'unknown', reward: 90 }],
      baselineByActionType: baseline,
      defaultBaseline: 70,
      totalHits: 100,
      importance: 0.5,
      c: 0,
    });
    expect(rank).toBeCloseTo(20 * (1 / 6));
  });

  it('贝叶斯收缩：样本越多 quality 越接近 lift', () => {
    const few = computeLessonRank({
      hits: [{ actionType: 'vote', reward: 80 }],
      baselineByActionType: baseline,
      defaultBaseline: 70,
      totalHits: 100,
      importance: 0.5,
      c: 0,
    });
    const many = computeLessonRank({
      hits: Array.from({ length: 100 }, () => ({ actionType: 'vote', reward: 80 })),
      baselineByActionType: baseline,
      defaultBaseline: 70,
      totalHits: 100,
      importance: 0.5,
      c: 0,
    });
    expect(few).toBeCloseTo(20 * (1 / 6));
    expect(many).toBeCloseTo(20 * (100 / 105));
    expect(many).toBeGreaterThan(few);
  });

  it('UCB 探索项：命中少时更大，让新经验有机会被注入', () => {
    const rankFew = computeLessonRank({
      hits: [{ actionType: 'vote', reward: 80 }],
      baselineByActionType: baseline,
      defaultBaseline: 70,
      totalHits: 100,
      importance: 0.5,
      c: 10,
    });
    const rankMany = computeLessonRank({
      hits: Array.from({ length: 10 }, () => ({ actionType: 'vote', reward: 80 })),
      baselineByActionType: baseline,
      defaultBaseline: 70,
      totalHits: 100,
      importance: 0.5,
      c: 10,
    });
    expect(rankFew).toBeGreaterThan(rankMany);
  });

  it('负 lift 产生负 quality，rank 可为负', () => {
    const rank = computeLessonRank({
      hits: [{ actionType: 'vote', reward: 30 }],
      baselineByActionType: baseline,
      defaultBaseline: 70,
      totalHits: 100,
      importance: 0.5,
      c: 0,
    });
    expect(rank).toBeCloseTo(-30 * (1 / 6));
  });
});

describe('computeLessonCandidateScore', () => {
  it('rank 为负时仍保持相似度越高候选分越高', () => {
    expect(computeLessonCandidateScore(0.9, -10)).toBeGreaterThan(
      computeLessonCandidateScore(0.2, -10),
    );
  });

  it('排除零或负相似度，避免负负相乘抬高无关 lesson', () => {
    expect(computeLessonCandidateScore(0, -10)).toBe(Number.NEGATIVE_INFINITY);
    expect(computeLessonCandidateScore(-0.5, -10)).toBe(Number.NEGATIVE_INFINITY);
  });
});
