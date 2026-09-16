import { EVALUATION_VERSION } from './evaluation-version';
import { JudgeService } from './judge.service';
import type {
  EvaluationProjectionService,
  EvaluationDefinition,
  EvaluatedResult,
} from './evaluation-projection.service';
import { createActionSource } from '../observability/action-source';

function projectionHarness() {
  const results = new Map<string, EvaluatedResult>();
  const definition = {
    modelName: 'frozen-judge',
    baseUrl: 'https://judge.test/v3',
    prompts: {},
  } as EvaluationDefinition;
  const projection = {
    evaluate: jest.fn(
      async (
        ...[gameId, eventId, runId, compute]: Parameters<EvaluationProjectionService['evaluate']>
      ) => {
        results.set(
          eventId,
          await compute(
            definition,
            createActionSource(`${gameId}/${runId}/${eventId}`),
            undefined as never,
          ),
        );
      },
    ),
  };
  return { projection, definition, results };
}

it('发言评分保留此前查验、顺序公告及弃票，排除未来发言和公告', async () => {
  const events = [
    {
      id: 'check',
      sequence: 11,
      day: 1,
      actionType: 'seer_check',
      actorId: 'p',
      visibility: 'seer',
      content: { targetSeatNo: 1, result: 'good' },
    },
    {
      id: 'order',
      sequence: 16,
      day: 1,
      actionType: 'speech_order_determined',
      actorId: null,
      visibility: 'public',
      content: {
        speechOrder: [2, 3, 4, 5, 6, 1],
        startSeatNo: 2,
        direction: 'clockwise',
        reason: 'time_rule_25_clockwise',
        message: '今天的发言顺序: 2 → 3 → 4 → 5 → 6 → 1',
      },
    },
    {
      id: 'e1',
      sequence: 17,
      day: 1,
      actionType: 'speech',
      actorId: 'p',
      visibility: 'public',
      content: { seatNo: 2, speech: 'first statement' },
    },
    {
      id: 'abstention',
      sequence: 24,
      day: 1,
      actionType: 'vote',
      actorId: 'p5',
      visibility: 'public',
      content: { voterSeatNo: 5, targetSeatNo: 0, voteRound: 0 },
    },
    {
      id: 'e2',
      sequence: 30,
      day: 1,
      actionType: 'speech',
      actorId: 'p',
      visibility: 'public',
      content: { seatNo: 2, speech: 'future statement' },
    },
    {
      id: 'future-order',
      sequence: 40,
      day: 2,
      actionType: 'speech_order_determined',
      actorId: null,
      visibility: 'public',
      content: {
        speechOrder: [3, 4, 5, 6, 1],
        startSeatNo: 3,
        direction: 'clockwise',
        reason: 'death_position',
        message: '今天的发言顺序: 3 → 4 → 5 → 6 → 1',
      },
    },
  ];
  const judgments = { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() };
  const prisma = {
    player: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'p',
        gameId: 'g',
        seatNo: 2,
        role: 'seer',
        faction: 'villager',
        deathDay: null,
      }),
    },
    event: {
      findMany: jest.fn(async (args) =>
        events.filter((e) =>
          args.where.sequence?.in
            ? args.where.sequence.in.includes(e.sequence)
            : e.sequence <= (args.where.sequence?.lte ?? Infinity),
        ),
      ),
    },
    game: { findUnique: jest.fn().mockResolvedValue({ experiment: null }) },
    $transaction: jest.fn(async (task) =>
      task({ decisionJudgment: judgments, $executeRaw: jest.fn() }),
    ),
  };
  const llm = {
    invokeReflective: jest.fn().mockResolvedValue({
      output: { items: [{ index: 1, score: 80, verdict: 'good', reasoning: 'evidence' }] },
      modelName: 'judge',
    }),
  };
  const prompts = {
    render: jest.fn(async (name, variables) => ({
      name,
      text: variables ? JSON.stringify(variables) : 'judge',
      version: 1,
    })),
  };
  const { projection, results } = projectionHarness();
  const service = new JudgeService(
    ...([prisma, prompts, llm, projection] as unknown as ConstructorParameters<
      typeof JudgeService
    >),
  );
  expect(await service.judgeSpeeches('g', 'p', undefined, 'run')).toBe(2);
  expect(llm.invokeReflective.mock.calls[0][0].user).toContain('first statement');
  expect(llm.invokeReflective.mock.calls[0][0].user).not.toContain('future statement');
  expect(llm.invokeReflective.mock.calls[1][0].user).toContain('first statement');
  expect(llm.invokeReflective.mock.calls[1][0].user).toContain('future statement');
  const firstUser = llm.invokeReflective.mock.calls[0][0].user;
  const lastUser = llm.invokeReflective.mock.calls[1][0].user;
  const order = '今天的发言顺序: 2 → 3 → 4 → 5 → 6 → 1';
  for (const user of [firstUser, lastUser]) {
    expect(user).toContain('预言家查验 1号位 → 好人');
    expect(user).toContain(order);
    expect(user.indexOf('预言家查验')).toBeLessThan(user.indexOf(order));
    expect(user.indexOf(order)).toBeLessThan(user.indexOf('first statement'));
    expect(user).not.toContain('今天的发言顺序: 3 → 4 → 5 → 6 → 1');
  }
  expect(firstUser).not.toContain('5号位弃票');
  expect(lastUser).toContain('5号位弃票');
  expect(lastUser).not.toContain('0号位');
  expect([...results.keys()]).toEqual(['e1', 'e2']);
  expect(judgments.upsert).not.toHaveBeenCalled();
});

it.each(['seer_check', 'wolf_kill', 'wolf_explode', 'witch_save'])(
  '新评分 %s 向投影交付结果，保留旧历史、团队归因和事前证据',
  async (actionType) => {
    const content =
      actionType === 'seer_check'
        ? { targetSeatNo: 4, result: 'werewolf', thinking: '选择未知玩家' }
        : actionType === 'wolf_explode'
          ? { action: 'hold', seatNo: 1, thinking: '最后一狼' }
          : actionType === 'witch_save'
            ? { saved: false, targetSeatNo: 0, thinking: '保留药物' }
            : { targetSeatNo: 4 };
    const old = {
      evaluationVersion: EVALUATION_VERSION - 1,
      previousEvaluations: [{ evaluationVersion: 1, score: 7 }],
      score: 12,
      verdict: 'bad',
      reasoning: 'old',
      modelName: 'old-model',
    };
    const judgments = { findUnique: jest.fn().mockResolvedValue(old), upsert: jest.fn() };
    const teams = { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() };
    const prisma = {
      event: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'e',
          gameId: 'g',
          actorId: actionType === 'wolf_kill' ? null : 'p',
          day: 1,
          sequence: 10,
          actionType,
          content,
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      player: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p',
          seatNo: 1,
          role: 'seer',
          faction: 'villager',
          deathDay: null,
        }),
        findFirst: jest.fn().mockResolvedValue({ id: 'p' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      game: {
        findUnique: jest.fn().mockResolvedValue({
          rulesetId: 'standard6p',
          ruleset: { definition: { roles: [] } },
          experiment: null,
        }),
      },
      decisionContext: {
        findUnique: jest.fn().mockResolvedValue({
          snapshot: { baseSystemPrompt: 'allowed evidence', schema: { legal: [4, 5] } },
        }),
      },
      decisionJudgment: judgments,
      teamJudgment: teams,
      $transaction: jest.fn(async (task) =>
        task({ decisionJudgment: judgments, teamJudgment: teams, $executeRaw: jest.fn() }),
      ),
    };
    const llm = {
      invokeReflective: jest.fn().mockResolvedValue({
        output: { verdict: 'good', score: 80, reasoning: 'new' },
        modelName: 'judge',
      }),
    };
    const prompts = {
      render: jest.fn(async (name, variables, _frozen?: unknown) => ({
        name,
        text: variables ? JSON.stringify(variables) : 'judge',
        version: 1,
      })),
    };
    const { projection, definition, results } = projectionHarness();
    const original = structuredClone(old);
    const service = new JudgeService(
      ...([prisma, prompts, llm, projection] as unknown as ConstructorParameters<
        typeof JudgeService
      >),
    );
    await service.judgeEvent('g', 'e', 'run');
    const input = llm.invokeReflective.mock.calls[0][0];
    expect(input.user).toContain('allowed evidence');
    expect(input.user).toContain('legal');
    expect(input.system).toContain('只依据决策时点');
    expect(input.modelName).toBe(definition.modelName);
    expect(input.baseUrl).toBe(definition.baseUrl);
    expect(prompts.render.mock.calls.every((call) => call[2] === definition.prompts)).toBe(true);
    expect(results.get('e')).toMatchObject({ score: 80, verdict: 'good', reasoning: 'new' });
    expect(old).toEqual(original);
    expect(judgments.upsert).not.toHaveBeenCalled();
    expect(teams.upsert).not.toHaveBeenCalled();
    if (actionType === 'wolf_kill') {
      expect(input.user).toContain('狼人阵营集体决策');
    } else if (actionType === 'seer_check') {
      expect(input.user).not.toContain('werewolf');
    }
  },
);
