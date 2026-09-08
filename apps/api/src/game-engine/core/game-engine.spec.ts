import { GameEngine } from './game-engine';
import { createGameState, createPlayer } from '../testing/test-utils';
import type { GameGraphState } from './types';
import type { GamePreset } from '../presets/game-presets';
import { ExperimentInvalidError } from '@/evaluation/experiment-integrity';

type TestableGameEngine = {
  run: GameEngine['run'];
  prisma: { game: { findUnique: jest.Mock }; $executeRaw?: jest.Mock };
  configService: { get: jest.Mock };
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
  it.each(['preflight', 'node'])('实验失效由引擎统一记录一次并中止（%s）', async (source) => {
    const engine = Object.create(GameEngine.prototype) as TestableGameEngine;
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
    engine.configService = { get: jest.fn().mockReturnValue('new') };
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
});
