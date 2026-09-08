import { BatchService } from './batch.service';
import type { BatchRunDto } from './dto/batch-run.dto';
import type { ExperimentSnapshot } from './experiment-snapshot';

it('配对默认只创建；同对两臂冻结相同配置并交替顺序，所有配对使用同一记忆基线', async () => {
  const agents = ['werewolf', 'werewolf', 'seer', 'witch', 'villager', 'villager'].map(
    (role, i) => ({
      id: `a${i}`,
      role,
      faction: role === 'werewolf' ? 'werewolf' : 'villager',
      defaultModelName: `m${i}`,
      memoryLabel: 'baseline',
      isActive: true,
    }),
  );
  const prisma = {
    ruleset: {
      findUnique: jest.fn().mockResolvedValue({
        playerCount: 6,
        definition: { roles: agents.map(({ role, faction }) => ({ role, faction })) },
      }),
    },
    agent: { findMany: jest.fn().mockResolvedValue(agents) },
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'reviewed' }]),
  };
  const captured: ExperimentSnapshot[] = [];
  const games = {
    createGame: jest.fn(async (_dto, snapshot) => {
      captured.push(snapshot);
      return { id: `g${captured.length}` };
    }),
    initializeGame: jest.fn(),
  };
  const launch = { start: jest.fn() };
  const memory = { captureExperimentMemories: jest.fn().mockResolvedValue([]) };
  const service = new BatchService(
    ...([
      prisma,
      games,
      launch,
      memory,
      { model: 'embedding', dimension: 2048 },
      { retrieveActivePatterns: jest.fn().mockResolvedValue([]) },
      { loadRequiredSkill: jest.fn(async (id) => ({ content: id })) },
      {
        captureSnapshot: jest.fn().mockResolvedValue({ template: { text: 'frozen', version: 1 } }),
      },
      { get: jest.fn().mockReturnValue('judge') },
    ] as unknown as ConstructorParameters<typeof BatchService>),
  );
  const result = await service.runBatch({
    count: 5,
    experiment: { paired: true },
    rulesetId: 'standard6p',
    agentIds: agents.map((a) => a.id),
    shuffleAgents: false,
  } as BatchRunDto);
  expect(result.count).toBe(10);
  expect(captured.slice(0, 4).map((s) => s.arm)).toEqual(['on', 'off', 'off', 'on']);
  expect(captured[0].assignments).toEqual(captured[1].assignments);
  expect(captured[2].assignments).toEqual(captured[3].assignments);
  expect(captured[0].pairId).not.toBe(captured[2].pairId);
  expect(captured[0].prompts).toEqual(captured[3].prompts);
  expect(captured[0].knowledgeChunkIds).toEqual(['reviewed']);
  expect(memory.captureExperimentMemories).toHaveBeenCalledTimes(1);
  expect(launch.start).not.toHaveBeenCalled();
});
