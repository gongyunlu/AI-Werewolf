import { JudgeService } from './judge.service';
import { EVALUATION_VERSION } from './evaluation-version';

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
  let tail = Promise.resolve();
  const table = {
    findUnique: jest.fn(async ({ where }) => structuredClone(rows.get(where.eventId) ?? null)),
    upsert: jest.fn(async ({ where, create, update }) => {
      rows.set(where.eventId, {
        ...(rows.get(where.eventId) ?? { previousEvaluations: [] }),
        ...(rows.has(where.eventId) ? update : create),
      });
    }),
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
    $transaction: jest.fn(async (task) => {
      let release: (() => void) | undefined;
      const tx = {
        decisionJudgment: table,
        teamJudgment: table,
        $executeRaw: jest.fn(async () => {
          const before = tail;
          tail = new Promise<void>((resolve) => {
            release = resolve;
          });
          await before;
        }),
      };
      try {
        return await task(tx);
      } finally {
        release?.();
      }
    }),
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
  const service = new JudgeService(
    ...([prisma, prompts, llm] as unknown as ConstructorParameters<typeof JudgeService>),
  );
  return { service, prisma, llm, rows, table };
}

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
  const { service, llm, rows, table } = harness();
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
  expect(rows.get('e1').score).toBe(80);
  await expect(service.judgeSpeeches('g', 'p', undefined, 'run')).resolves.toBe(2);
  expect(llm.invokeReflective).toHaveBeenCalledTimes(3);
  expect(table.upsert.mock.calls.map(([args]) => args.where.eventId)).toEqual(['e1', 'e2']);
  expect(rows.get('e1').previousEvaluations).toEqual([]);
  await service.judgeSpeeches('g', 'p', undefined, 'new-run');
  expect(llm.invokeReflective).toHaveBeenCalledTimes(5);
  expect(rows.get('e1').previousEvaluations).toEqual([
    expect.objectContaining({ evaluationRunId: 'run', score: 80 }),
  ]);
});

it.each(['seer_check', 'wolf_kill'])('并发重评 %s 保留原分及两次新分', async (actionType) => {
  const { service, llm, rows } = harness(actionType);
  rows.set('e1', {
    score: 12,
    verdict: 'bad',
    reasoning: 'old',
    modelName: 'old',
    evaluationVersion: EVALUATION_VERSION - 1,
    previousEvaluations: [],
  });
  for (const score of [80, 90])
    llm.invokeReflective.mockResolvedValueOnce({
      output: { score, verdict: 'good', reasoning: 'new' },
      modelName: 'judge',
    });
  await Promise.all([
    service.judgeEvent('g', 'e1', 'run-80'),
    service.judgeEvent('g', 'e1', 'run-90'),
  ]);
  const result = rows.get('e1');
  expect(
    [...result.previousEvaluations.map((v: any) => v.score), result.score].toSorted(
      (a, b) => a - b,
    ),
  ).toEqual([12, 80, 90]);
});

it('团队狼刀评分包含提刀推理、记忆和动作约束，移除攻略文本', async () => {
  const { service, llm } = harness('wolf_kill');
  await service.judgeEvent('g', 'e1', 'run');
  const { user } = llm.invokeReflective.mock.calls[0][0];
  expect(user).toContain('提刀依据');
  expect(user).toContain('当时记忆证据');
  expect(user).toContain('legal');
  expect(user).not.toContain('不得出现在评分器的攻略');
});
