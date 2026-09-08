import { PrismaClient } from '../generated/prisma/client';
import { EVALUATION_VERSION } from './evaluation-version';

jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: jest.fn() }));
jest.mock('../generated/prisma/client', () => ({
  PrismaClient: jest.fn(),
  Prisma: { TransactionIsolationLevel: { RepeatableRead: 'RepeatableRead' } },
}));

it('CLI 报告接纳当前版本的个人、发言与团队评分', async () => {
  const events = [
    {
      id: 'decision',
      actorId: 'p',
      actionType: 'seer_check',
      visibility: 'seer',
      content: { targetSeatNo: 2 },
    },
    {
      id: 'speech',
      actorId: 'p',
      actionType: 'speech',
      visibility: 'public',
      content: { speech: '可见证据' },
    },
    {
      id: 'team',
      actorId: null,
      actionType: 'wolf_kill',
      visibility: 'wolf',
      content: { targetSeatNo: 3 },
    },
  ];
  const judgments = events.map((e) => ({
    eventId: e.id,
    playerId: e.actorId,
    actionType: e.actionType,
    evaluationRunId: 'run',
    evaluationVersion: EVALUATION_VERSION,
    score: 80,
    faction: 'werewolf',
  }));
  const db = {
    game: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'g',
          status: 'finished',
          experiment: null,
          players: [
            { id: 'p', agentId: 'a', role: 'seer', faction: 'villager', modelName: 'model' },
          ],
        },
      ]),
    },
    decisionJudgment: { findMany: jest.fn().mockResolvedValue(judgments.slice(0, 2)) },
    teamJudgment: { findMany: jest.fn().mockResolvedValue(judgments.slice(2)) },
    event: { findMany: jest.fn().mockResolvedValue(events) },
    knowledgeUsage: { count: jest.fn().mockResolvedValue(0) },
    knowledgeRetrieval: { findMany: jest.fn().mockResolvedValue([]) },
    decisionContext: { findMany: jest.fn().mockResolvedValue([]) },
    evaluationRun: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'run',
        status: 'complete',
        expectedEventIds: events.map((e) => e.id),
      }),
    },
  };
  jest.mocked(PrismaClient).mockImplementation(
    () =>
      ({
        $transaction: async (task: (client: typeof db) => Promise<unknown>) => task(db),
        $disconnect: jest.fn(),
      }) as never,
  );
  const argv = process.argv;
  process.argv = ['node', 'measure-ab', '--games=g', '--on=g'];
  let stdout: jest.SpyInstance | undefined;
  let stderr: jest.SpyInstance | undefined;
  try {
    const result = new Promise<any>((resolve, reject) => {
      stdout = jest.spyOn(process.stdout, 'write').mockImplementation((text) => {
        resolve(JSON.parse(String(text)));
        return true;
      });
      stderr = jest.spyOn(process.stderr, 'write').mockImplementation((text) => {
        reject(new Error(String(text)));
        return true;
      });
    });
    jest.requireActual('./measure-ab');
    const report = await result;
    expect(report.manifest[0]).toMatchObject({
      included: true,
      evaluation: { complete: true, missing: [] },
    });
    expect(Object.keys(report.byEvaluationVersion)).toEqual([String(EVALUATION_VERSION)]);
    expect(report.byEvaluationVersion[EVALUATION_VERSION].decision.on.n).toBe(1);
    expect(report.byEvaluationVersion[EVALUATION_VERSION].speech.on.n).toBe(1);
    expect(Object.values(report.teamStrata)).toEqual([
      expect.objectContaining({ on: expect.objectContaining({ n: 1 }) }),
    ]);
  } finally {
    process.argv = argv;
    stdout?.mockRestore();
    stderr?.mockRestore();
  }
});
