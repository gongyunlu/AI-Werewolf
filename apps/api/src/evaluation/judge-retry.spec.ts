import { JudgeService } from './judge.service';
import { EVALUATION_VERSION } from './evaluation-version';
import type {
  EvaluationProjectionService,
  EvaluationDefinition,
  EvaluatedResult,
} from './evaluation-projection.service';
import { createActionSource } from '../observability/action-source';

function harness(actionType = 'speech') {
  const events = [1, 2].map((sequence) => ({
    id: `e${sequence}`,
    gameId: 'g',
    sequence,
    day: 1,
    actionType,
    actorId: actionType === 'wolf_kill' ? null : 'p',
    visibility: 'public',
    content: {
      speech: `statement-${sequence}`,
      targetSeatNo: 3,
      ...(actionType === 'wolf_kill' ? { proposalEventIds: ['proposal'] } : {}),
    },
  }));
  const rows = new Map<string, any>();
  const table = {
    findUnique: jest.fn(async ({ where }) => structuredClone(rows.get(where.eventId) ?? null)),
    upsert: jest.fn(),
  };
  const prisma = {
    player: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'p',
        gameId: 'g',
        seatNo: 1,
        role: 'villager',
        faction: 'villager',
        deathDay: null,
      }),
      findFirst: jest.fn().mockResolvedValue({ id: 'p' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    event: {
      findUnique: jest.fn(async ({ where }) => events.find((e) => e.id === where.id)),
      findMany: jest.fn(async ({ where }) =>
        where.actionType === 'wolf_proposal'
          ? [{ id: 'proposal', content: { thinking: '提刀依据' } }]
          : events.filter((e) =>
              where.sequence?.in
                ? where.sequence.in.includes(e.sequence)
                : e.sequence <=
                  (where.sequence?.lte ??
                    (where.sequence?.lt !== undefined ? where.sequence.lt - 1 : Infinity)),
            ),
      ),
    },
    game: {
      findUnique: jest.fn().mockResolvedValue({ experiment: null, ruleset: { definition: {} } }),
    },
    decisionContext: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([
        {
          eventId: 'proposal',
          snapshot: {
            baseSystemPrompt: '当时记忆证据',
            schema: { legal: [3, 4] },
            knowledge: '不得出现在评分器的攻略',
          },
        },
      ]),
    },
    decisionJudgment: table,
    teamJudgment: table,
    $transaction: jest.fn(),
  };
  const prompts = {
    render: jest.fn(async (_name, variables) => ({
      text: JSON.stringify(variables ?? {}),
      name: 'prompt',
      version: 1,
    })),
  };
  const llm = {
    invokeReflective: jest.fn().mockResolvedValue({
      output: {
        items: [{ index: 1, score: 80, verdict: 'good', reasoning: 'evidence' }],
        score: 80,
        verdict: 'good',
        reasoning: 'evidence',
      },
      modelName: 'judge',
    }),
  };
  // 这里只模拟投影接口对成功判分的复用；平台交付、锁和整批采用由隔离集成测试验证。
  const results = new Map<string, EvaluatedResult>();
  const definition = {
    modelName: 'judge-frozen',
    baseUrl: 'https://judge.test/v3',
    prompts: {},
  } as EvaluationDefinition;
  const projection = {
    evaluate: jest.fn(
      async (
        ...[gameId, eventId, runId, compute]: Parameters<EvaluationProjectionService['evaluate']>
      ) => {
        const key = `${runId}/${eventId}`;
        if (!results.has(key))
          results.set(
            key,
            await compute(definition, createActionSource(`${gameId}/${key}`), undefined as never),
          );
      },
    ),
  };
  const service = new JudgeService(
    ...([prisma, prompts, llm, projection] as unknown as ConstructorParameters<
      typeof JudgeService
    >),
  );
  return { service, prisma, llm, rows, table, projection, results };
}

it('同一决策评估任务重试不再次判分', async () => {
  const { service, llm, projection } = harness('vote');
  await service.judgeEvent('g', 'e1', 'run');
  await service.judgeEvent('g', 'e1', 'run');
  expect(llm.invokeReflective).toHaveBeenCalledTimes(1);
  expect(projection.evaluate).toHaveBeenNthCalledWith(1, 'g', 'e1', 'run', expect.any(Function));
  expect(projection.evaluate).toHaveBeenNthCalledWith(2, 'g', 'e1', 'run', expect.any(Function));
});

it('投票评分读取私有快照中的当次理由，不向评分器注入攻略', async () => {
  const { service, prisma, llm } = harness('vote');
  prisma.decisionContext.findUnique.mockResolvedValue({
    snapshot: {
      reasoning: '当前投票的私有理由',
      baseSystemPrompt: '可见局势',
      knowledge: '攻略不应进入评分',
      schema: { legal: [3] },
    },
  });
  await service.judgeEvent('g', 'e1', 'run');
  const { user } = llm.invokeReflective.mock.calls[0][0];
  expect(user).toContain('当前投票的私有理由');
  expect(user).not.toContain('攻略不应进入评分');
});

it('发言 1 成功、2 失败后，重试只调用 2；新批次才重评两条', async () => {
  const { service, llm, results, table } = harness();
  const output = {
    output: { items: [{ index: 1, score: 80, verdict: 'good', reasoning: 'evidence' }] },
    modelName: 'judge',
  };
  llm.invokeReflective
    .mockResolvedValueOnce(output)
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockResolvedValue(output);
  await expect(service.judgeSpeeches('g', 'p', undefined, 'run')).rejects.toThrow(
    'temporary failure',
  );
  expect(results.get('run/e1')?.score).toBe(80);
  expect(results.has('run/e2')).toBe(false);
  await expect(service.judgeSpeeches('g', 'p', undefined, 'run')).resolves.toBe(2);
  expect(llm.invokeReflective).toHaveBeenCalledTimes(3);
  expect([...results.keys()]).toEqual(['run/e1', 'run/e2']);
  expect(table.upsert).not.toHaveBeenCalled();
  await service.judgeSpeeches('g', 'p', undefined, 'new-run');
  expect(llm.invokeReflective).toHaveBeenCalledTimes(5);
  expect([...results.keys()]).toEqual(['run/e1', 'run/e2', 'new-run/e1', 'new-run/e2']);
  expect(table.upsert).not.toHaveBeenCalled();
});

it.each(['seer_check', 'wolf_kill'])(
  '不同运行重评 %s 只交付本次结果，旧投影和历史保持原值',
  async (actionType) => {
    const { service, llm, rows, results, table } = harness(actionType);
    const old = {
      score: 12,
      verdict: 'bad',
      reasoning: 'old',
      modelName: 'old',
      evaluationVersion: EVALUATION_VERSION - 1,
      previousEvaluations: [{ evaluationVersion: 1, score: 7 }],
    };
    rows.set('e1', structuredClone(old));
    for (const score of [80, 90])
      llm.invokeReflective.mockResolvedValueOnce({
        output: { score, verdict: 'good', reasoning: 'new' },
        modelName: 'judge',
      });
    await Promise.all([
      service.judgeEvent('g', 'e1', 'run-80'),
      service.judgeEvent('g', 'e1', 'run-90'),
    ]);
    expect(results.get('run-80/e1')?.score).toBe(80);
    expect(results.get('run-90/e1')?.score).toBe(90);
    expect(rows.get('e1')).toEqual(old);
    expect(table.upsert).not.toHaveBeenCalled();
  },
);

it('团队狼刀评分包含提刀推理、记忆和动作约束，移除攻略文本', async () => {
  const { service, llm } = harness('wolf_kill');
  await service.judgeEvent('g', 'e1', 'run');
  const { user } = llm.invokeReflective.mock.calls[0][0];
  expect(user).toContain('提刀依据');
  expect(user).toContain('当时记忆证据');
  expect(user).toContain('legal');
  expect(user).not.toContain('不得出现在评分器的攻略');
});
