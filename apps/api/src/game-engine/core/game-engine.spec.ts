import { GameEngine } from './game-engine';
import { createGameState, createPlayer } from '../testing/test-utils';
import type { GameGraphState } from './types';
import type { GamePreset } from '../presets/game-presets';

type TestableGameEngine = {
  run: GameEngine['run'];
  initialize: jest.Mock;
  checkPause: jest.Mock;
  executePhase: jest.Mock;
  executeNode: jest.Mock;
  generateDaySummaries: jest.Mock;
  executeDayPhase: (state: GameGraphState) => Promise<GameGraphState>;
  preset: GamePreset;
  pauseCheckCache: null;
};

describe('GameEngine lifecycle', () => {
  it('进入主循环前执行 init 节点', async () => {
    const engine = Object.create(GameEngine.prototype) as TestableGameEngine;
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
