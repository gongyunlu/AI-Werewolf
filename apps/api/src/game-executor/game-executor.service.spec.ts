import { GameExecutorService } from './game-executor.service';
import { GameEngine } from '../game-engine/core/game-engine';
import {
  GameAbortedException,
  GamePausedException,
} from '../game-engine/core/game-engine.exception';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { PostGameAnalysisError } from './game-executor.exception';

const GAME_ID = 'game-1';

function createHarness() {
  const prisma = {
    game: {
      findUnique: jest.fn().mockResolvedValue({
        id: GAME_ID,
        rulesetId: 'standard6p',
        skillVersion: 'v1',
        status: GAME_STATUSES.RUNNING,
        ruleset: { id: 'standard6p' },
        players: [
          {
            id: 'player-1',
            seatNo: 1,
            role: 'villager',
            faction: 'villager',
            isSheriff: false,
          },
        ],
      }),
    },
  };
  const agentRuntime = { validateRequiredSkills: jest.fn().mockResolvedValue(undefined) };
  const eventWriter = { initializeSequenceCounter: jest.fn().mockResolvedValue(undefined) };
  const gameAnalysis = {
    analyzeGame: jest.fn().mockResolvedValue({ judged: 1, reflectPlanned: 1 }),
  };

  const service = new GameExecutorService(
    prisma as never,
    agentRuntime as never,
    eventWriter as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    gameAnalysis as never,
    {} as never,
    {} as never,
  );

  return { service, gameAnalysis };
}

describe('GameExecutorService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('赛后结算或分析投递失败时向上抛出，供 GameWorker 触发重试', async () => {
    const { service, gameAnalysis } = createHarness();
    const deliveryError = new Error('queue unavailable');
    jest.spyOn(GameEngine.prototype, 'run').mockImplementation(async (state) => state);
    gameAnalysis.analyzeGame.mockRejectedValueOnce(deliveryError);

    await expect(service.executeGame(GAME_ID)).rejects.toMatchObject({
      name: 'PostGameAnalysisError',
      originalError: deliveryError,
    } satisfies Partial<PostGameAnalysisError>);
    expect(gameAnalysis.analyzeGame).toHaveBeenCalledWith(GAME_ID);
    expect(service.abortGame(GAME_ID)).toBe(false);
  });

  it.each([
    ['暂停', new GamePausedException(GAME_ID)],
    ['取消', new GameAbortedException(GAME_ID)],
  ])('游戏%s时保留正常退出语义，不投递赛后分析', async (_label, exception) => {
    const { service, gameAnalysis } = createHarness();
    jest.spyOn(GameEngine.prototype, 'run').mockRejectedValueOnce(exception);

    const state = await service.executeGame(GAME_ID);

    expect(state.gameId).toBe(GAME_ID);
    expect(gameAnalysis.analyzeGame).not.toHaveBeenCalled();
  });
});
