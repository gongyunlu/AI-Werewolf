import { GameEngine } from './game-engine';
import { createGameState, createPlayer } from '../testing/test-utils';
import type { GameGraphState } from './types';
import type { GamePreset } from '../presets/game-presets';
import { ExperimentInvalidError } from '@/evaluation/experiment-integrity';
import { NodeRegistry } from '../nodes/node-registry';

type TestableGameEngine = {
  run: GameEngine['run'];
  prisma: { game: { findUnique: jest.Mock }; $executeRaw?: jest.Mock };
  configService: { get: jest.Mock };
  nodeContext: object;
  nodeRegistry: NodeRegistry;
  initialize: jest.Mock;
  checkPause: jest.Mock;
  executePhase: jest.Mock;
  executeNode: jest.Mock;
  generateDaySummaries: jest.Mock;
  executeDayPhase: (state: GameGraphState) => Promise<GameGraphState>;
  executeNightPhase: (state: GameGraphState) => Promise<GameGraphState>;
  preset: GamePreset;
  pauseCheckCache: null;
};

describe('GameEngine lifecycle', () => {
  it('节点边界检查取消，非模型节点也不能在取消后开始', async () => {
    const controller = new AbortController();
    const engine = Object.create(GameEngine.prototype) as TestableGameEngine;
    engine.nodeContext = { signal: controller.signal };
    engine.nodeRegistry = new NodeRegistry({});
    const node = jest.fn(async () => {
      controller.abort();
      return {};
    });
    const getNode = jest.spyOn(engine.nodeRegistry, 'getNode').mockReturnValue(node);
    const state = createGameState({ gameId: 'g', players: [] });
    try {
      await expect(engine.executeNode('nightResolve', state)).rejects.toMatchObject({
        name: 'AbortError',
      });
      await expect(engine.executeNode('gameEnd', state)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(node).toHaveBeenCalledTimes(1);
      expect(getNode).toHaveBeenCalledTimes(1);
    } finally {
      getNode.mockRestore();
    }
  });
  it.each(['preflight', 'node'])('实验失效由引擎统一记录一次并中止（%s）', async (source) => {
    const engine = Object.create(GameEngine.prototype) as TestableGameEngine;
    engine.configService = { get: jest.fn() };
    engine.nodeContext = {};
    engine.initialize = jest.fn();
    engine.prisma = {
      game: {
        findUnique: jest.fn().mockResolvedValue({
          experiment:
            source === 'preflight'
              ? {
                  version: 1,
                  arm: 'on',
                  memories: [],
                  embeddingModel: 'old',
                  capturedAt: '2026-09-06T00:00:00Z',
                }
              : null,
        }),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    engine.configService = {
      get: jest.fn((key) => (key === 'ARK_EMBEDDING_MODEL' ? 'new' : undefined)),
    };
    engine.executeNode = jest
      .fn()
      .mockRejectedValue(new ExperimentInvalidError('frozen retrieval failed'));
    await expect(engine.run(createGameState({ gameId: 'g', players: [] }))).rejects.toBeInstanceOf(
      ExperimentInvalidError,
    );
    expect(engine.prisma.$executeRaw).toHaveBeenCalledTimes(1);
    if (source === 'preflight') expect(engine.executeNode).not.toHaveBeenCalled();
    else expect(engine.executeNode).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('自爆消费中断，判胜后推进轮次（结束=%s）', async (endsGame) => {
    const engine = Object.create(GameEngine.prototype) as TestableGameEngine;
    engine.configService = { get: jest.fn() };
    engine.nodeContext = {};
    engine.preset = {
      name: 'test',
      nightPipeline: ['nightResolve'],
      dayPipeline: ['announceDay', 'wolfExplode', 'speech', 'vote'],
    };
    let exploded = false;
    engine.executeNode = jest.fn(async (name, state) => {
      if (name === 'wolfExplode' && !exploded) {
        exploded = true;
        return { ...state, interrupt: { type: 'wolf_explode', triggeredBy: 'wolf' } };
      }
      return name === 'checkWin' ? { ...state, isGameOver: endsGame } : state;
    });
    engine.generateDaySummaries = jest.fn();
    const initial = createGameState(
      { gameId: 'game-1', players: [] },
      { currentDay: 1, nextIsDay: true },
    );
    const after = await engine.executeDayPhase(initial);
    expect(after.interrupt).toBeNull();
    expect(after.currentDay).toBe(endsGame ? 1 : 2);
    expect(after.isGameOver).toBe(endsGame);
    expect(engine.executeNode.mock.calls.map((call) => call[0])).toEqual([
      'announceDay',
      'wolfExplode',
      'checkWin',
    ]);
    if (!endsGame) {
      engine.executeNode.mockClear();
      const morning = await engine.executeNightPhase(after);
      const next = await engine.executeDayPhase(morning);
      expect(engine.executeNode.mock.calls.map((call) => call[0])).toEqual([
        'nightResolve',
        'announceDay',
        'wolfExplode',
        'speech',
        'vote',
      ]);
      expect(next.currentDay).toBe(3);
    }
  });
  it('进入主循环前执行 init 节点', async () => {
    const engine = Object.create(GameEngine.prototype) as TestableGameEngine;
    engine.configService = { get: jest.fn() };
    engine.nodeContext = {};
    engine.prisma = { game: { findUnique: jest.fn().mockResolvedValue(null) } };
    const initialState = createGameState({
      gameId: 'game-1',
      players: [createPlayer('player-1', 1, 'villager', 'villager', true)],
    });
    engine.initialize = jest.fn();
    engine.checkPause = jest.fn().mockResolvedValue(undefined);
    engine.executePhase = jest
      .fn()
      .mockImplementation(async (state) => ({ ...state, isGameOver: true, winner: 'villager' }));
    engine.executeNode = jest.fn().mockImplementation(async (_name, state) => state);

    await engine.run(initialState);

    expect(engine.executeNode.mock.calls[0][0]).toBe('init');
    expect(engine.executeNode.mock.calls.at(-1)?.[0]).toBe('gameEnd');
  });

  it('白天触发游戏结束时不增加天数', async () => {
    const engine = Object.create(GameEngine.prototype) as TestableGameEngine;
    engine.configService = { get: jest.fn() };
    engine.nodeContext = {};
    const state = createGameState(
      {
        gameId: 'game-1',
        players: [createPlayer('player-1', 1, 'villager', 'villager', true)],
      },
      { currentDay: 1, currentPhase: 'speech', nextIsDay: true },
    );
    engine.preset = {
      name: 'test',
      nightPipeline: ['nightResolve'],
      dayPipeline: ['checkWin'],
    };
    engine.executeNode = jest
      .fn()
      .mockImplementation(async (_name, current) => ({ ...current, isGameOver: true }));
    engine.generateDaySummaries = jest.fn();

    const result = await engine.executeDayPhase(state);

    expect(result.currentDay).toBe(1);
    expect(result.nextIsDay).toBe(false);
    expect(engine.generateDaySummaries).not.toHaveBeenCalled();
  });

  it('没有阶段进展时达到预算即退出，不编造 gameEnd', async () => {
    const engine = Object.create(GameEngine.prototype) as TestableGameEngine;
    engine.configService = { get: jest.fn((key) => (key === 'GAME_MAX_DAYS' ? 1 : undefined)) };
    engine.nodeContext = {};
    engine.prisma = { game: { findUnique: jest.fn().mockResolvedValue(null) } };
    engine.initialize = jest.fn();
    engine.checkPause = jest.fn();
    engine.executeNode = jest.fn(async (_name, state) => state);
    engine.executePhase = jest.fn(async (state) => state);
    await expect(engine.run(createGameState({ gameId: 'g', players: [] }))).rejects.toThrow(
      '最大轮次',
    );
    expect(engine.executePhase).toHaveBeenCalledTimes(2);
    expect(engine.executeNode.mock.calls.map(([name]) => name)).not.toContain('gameEnd');
  });
});
