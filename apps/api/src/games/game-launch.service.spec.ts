import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GameQueueService } from '../game-queue/game-queue.service';
import { GameLaunchService } from './game-launch.service';
import { GamesService } from './games.service';

jest.mock('./games.service', () => ({
  GamesService: jest.fn(),
}));

describe('GameLaunchService', () => {
  const game = { id: 'game-1', status: 'running' };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function createService(options?: {
    enqueueError?: Error;
    cancelResult?: boolean;
    cancelError?: Error;
    rollbackError?: Error;
  }) {
    const gamesService = {
      startGame: jest.fn().mockResolvedValue(game),
      rollbackFailedStart: options?.rollbackError
        ? jest.fn().mockRejectedValue(options.rollbackError)
        : jest.fn().mockResolvedValue(undefined),
    };
    const gameQueue = {
      addGameJob: options?.enqueueError
        ? jest.fn().mockRejectedValue(options.enqueueError)
        : jest.fn().mockResolvedValue('game-1'),
      cancelJob: options?.cancelError
        ? jest.fn().mockRejectedValue(options.cancelError)
        : jest.fn().mockResolvedValue(options?.cancelResult ?? true),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        GameLaunchService,
        { provide: GamesService, useValue: gamesService },
        { provide: GameQueueService, useValue: gameQueue },
      ],
    }).compile();

    return {
      service: moduleRef.get(GameLaunchService),
      gamesService,
      gameQueue,
    };
  }

  it('状态转换成功后投递任务并返回游戏', async () => {
    const { service, gamesService, gameQueue } = await createService();

    await expect(service.start('game-1')).resolves.toBe(game);
    expect(gamesService.startGame).toHaveBeenCalledWith('game-1');
    expect(gameQueue.addGameJob).toHaveBeenCalledWith('game-1');
    expect(gamesService.rollbackFailedStart).not.toHaveBeenCalled();
  });

  it('入队失败且任务确认移除后回滚状态', async () => {
    const enqueueError = new Error('redis unavailable');
    const { service, gamesService, gameQueue } = await createService({
      enqueueError,
      cancelResult: true,
    });

    await expect(service.start('game-1')).rejects.toBe(enqueueError);
    expect(gameQueue.cancelJob).toHaveBeenCalledWith('game-1');
    expect(gamesService.rollbackFailedStart).toHaveBeenCalledWith('game-1');
  });

  it('入队失败但任务未确认移除时保留 running 状态', async () => {
    const enqueueError = new Error('redis acknowledgement lost');
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { service, gamesService, gameQueue } = await createService({
      enqueueError,
      cancelResult: false,
    });

    await expect(service.start('game-1')).rejects.toBe(enqueueError);
    expect(gameQueue.cancelJob).toHaveBeenCalledWith('game-1');
    expect(gamesService.rollbackFailedStart).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      {
        gameId: 'game-1',
        enqueueError: enqueueError.message,
      },
      expect.stringContaining('保留 running 状态'),
    );
  });

  it('取消任务失败时保留 running 状态并抛出原始入队错误', async () => {
    const enqueueError = new Error('redis acknowledgement lost');
    const cancelError = new Error('redis unavailable during compensation');
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { service, gamesService } = await createService({ enqueueError, cancelError });

    await expect(service.start('game-1')).rejects.toBe(enqueueError);
    expect(gamesService.rollbackFailedStart).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      {
        gameId: 'game-1',
        enqueueError: enqueueError.message,
        compensationError: cancelError.message,
      },
      expect.stringContaining('保留 running 状态'),
    );
  });

  it('任务已移除但状态回滚失败时记录错误并抛出原始入队错误', async () => {
    const enqueueError = new Error('redis acknowledgement lost');
    const rollbackError = new Error('database unavailable');
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { service, gamesService } = await createService({
      enqueueError,
      cancelResult: true,
      rollbackError,
    });

    await expect(service.start('game-1')).rejects.toBe(enqueueError);
    expect(gamesService.rollbackFailedStart).toHaveBeenCalledWith('game-1');
    expect(loggerError).toHaveBeenCalledWith(
      {
        gameId: 'game-1',
        enqueueError: enqueueError.message,
        compensationError: rollbackError.message,
      },
      '游戏队列任务已移除，但启动状态回滚失败',
    );
  });
});
