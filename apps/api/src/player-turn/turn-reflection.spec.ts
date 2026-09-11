import { reviewed } from '../testing/turn-review.fixture';
import {
  reflectTurn,
  TurnReviewSchema,
  applySpeechRevision,
  type TurnReview,
} from './turn-reflection';
const conflict: TurnReview = {
  ...reviewed(),
  issues: [
    { kind: 'action_reason', explanation: '动作自爆，理由却明确不自爆', evidenceSequences: [] },
  ],
};
const draft = { decision: { action: 'explode' }, reasoning: '不选择自爆' };
const fixed = { decision: { action: 'hold' }, reasoning: '无收益，不自爆' };

it('没有发现问题时接受显式空列表，缺失或错误结构不能补成通过', async () => {
  expect(TurnReviewSchema.safeParse({}).success).toBe(false);
  expect(TurnReviewSchema.safeParse({ issues: {} }).success).toBe(false);
  const revise = jest.fn();
  const result = await reflectTurn({
    initial: draft,
    maxRounds: 3,
    evidenceSequences: new Set(),
    review: async () => ({ issues: [] }),
    revise,
  });
  expect(result).toMatchObject({ status: 'passed', final: draft });
  expect(revise).not.toHaveBeenCalled();
});

it('问题必须描述具体依据，不能用空解释代替复核意见', () => {
  expect(
    TurnReviewSchema.safeParse({
      issues: [{ kind: 'timeline', explanation: '', evidenceSequences: [30] }],
    }).success,
  ).toBe(false);
});

it('局部修订只替换指定原文，多个替换均以原稿为准', () => {
  const result = applySpeechRevision(
    { reasoning: '分析', content: '首夜4号金水。昨天4号发言。6号最先摘出自己。' },
    {
      reasoning: '已核对日期和发言顺序',
      contentEdits: [
        { before: '昨天4号发言', after: '今天4号发言' },
        { before: '6号最先摘出自己', after: '6号也摘出了自己' },
      ],
    },
  );
  expect(result.content).toBe('首夜4号金水。今天4号发言。6号也摘出了自己。');
});

it.each([
  [[{ before: '不存在', after: '新词' }]],
  [[{ before: '原文', after: '新词' }]],
  [
    [
      { before: '甲原文', after: '甲' },
      { before: '原文乙', after: '乙' },
    ],
  ],
  [[{ before: '甲原文乙原文', after: '' }]],
])('不接受无法唯一定位、重叠或清空全文的修订 %j', (contentEdits) => {
  expect(() =>
    applySpeechRevision(
      { reasoning: '分析', content: '甲原文乙原文' },
      {
        reasoning: '修订',
        contentEdits,
      },
    ),
  ).toThrow();
});

it('纠正动作与理由矛盾，并再次检查实际修订结果', async () => {
  const review = jest.fn().mockResolvedValueOnce(conflict).mockResolvedValueOnce(reviewed());
  const revise = jest.fn().mockResolvedValue(fixed);
  const result = await reflectTurn({
    initial: draft,
    maxRounds: 3,
    evidenceSequences: new Set(),
    review,
    revise,
  });
  expect(result).toMatchObject({ status: 'passed', initial: draft, final: fixed });
  expect(review.mock.calls[1][0]).toEqual(fixed);
  expect(revise).toHaveBeenCalledTimes(1);
});

it('合法但解释矛盾的选择不会被规则层强制改成 hold', async () => {
  const revise = jest.fn().mockResolvedValue(draft);
  const result = await reflectTurn({
    initial: draft,
    maxRounds: 3,
    evidenceSequences: new Set(),
    review: async () => conflict,
    revise,
  });
  expect(result).toMatchObject({ status: 'no_progress', final: draft });
});

it('首稿无问题就结束，不机械跑满轮数', async () => {
  const revise = jest.fn();
  const result = await reflectTurn({
    initial: fixed,
    maxRounds: 5,
    evidenceSequences: new Set(),
    review: async () => reviewed(),
    revise,
  });
  expect(result.status).toBe('passed');
  expect(result.rounds).toHaveLength(1);
  expect(revise).not.toHaveBeenCalled();
});

it('轮数上限不冒充通过，不提交未经复核的新修订', async () => {
  const revise = jest.fn();
  const result = await reflectTurn({
    initial: draft,
    maxRounds: 1,
    evidenceSequences: new Set(),
    review: async () => conflict,
    revise,
  });
  expect(result).toMatchObject({ status: 'limit_reached', final: draft });
  expect(revise).not.toHaveBeenCalled();
});

it('复核引用不可见或未来事件时，不据此修改原稿', async () => {
  const revise = jest.fn();
  const result = await reflectTurn({
    initial: fixed,
    maxRounds: 3,
    evidenceSequences: new Set([30]),
    review: async () => ({
      ...reviewed(),
      issues: [{ kind: 'unsupported_fact', explanation: '未来的查验', evidenceSequences: [44] }],
    }),
    revise,
  });
  expect(result).toMatchObject({ status: 'unsupported_review', final: fixed });
  expect(revise).not.toHaveBeenCalled();
});

it('复核完成时收到取消，不返回可提交结果', async () => {
  const c = new AbortController();
  await expect(
    reflectTurn({
      initial: draft,
      maxRounds: 3,
      signal: c.signal,
      evidenceSequences: new Set(),
      review: async () => {
        c.abort();
        return reviewed();
      },
      revise: jest.fn(),
    }),
  ).rejects.toThrow();
});
