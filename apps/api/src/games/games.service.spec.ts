import { BadRequestException } from '@nestjs/common';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { GamesService } from './games.service';

function createService() {
  const prisma = {
    ruleset: { findUnique: jest.fn() },
    agent: { findMany: jest.fn() },
    game: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ game: { update: jest.fn().mockResolvedValue(undefined) } }),
    ),
  };
  const gameExecutor = { abortGame: jest.fn() };
  const broadcaster = {
    getOrCreate: jest.fn(),
    emit: jest.fn(),
    complete: jest.fn(),
  };

  return {
    service: new GamesService(
      prisma as never,
      gameExecutor as never,
      broadcaster as never,
      { get: () => 'https://mock.invalid' } as never,
    ),
    prisma,
    gameExecutor,
    broadcaster,
  };
}

describe('GamesService', () => {
  it('创建对局时冻结模型、实际端点与凭证来源，不保存密钥', async () => {
    const { service, prisma } = createService();
    prisma.ruleset.findUnique.mockResolvedValue({ id: 'standard6p', playerCount: 2 });
    prisma.agent.findMany.mockResolvedValue([
      {
        id: 'default-agent',
        name: '默认玩家',
        isActive: true,
        defaultModelName: 'default-model',
        baseUrl: null,
      },
      {
        id: 'custom-agent',
        name: '独立玩家',
        isActive: true,
        defaultModelName: 'custom-model',
        baseUrl: 'https://custom.invalid',
        apiKeyCiphertext: '密文',
      },
    ]);

    await service.createGame({
      rulesetId: 'standard6p',
      agentIds: ['default-agent', 'custom-agent'],
    });

    const players = prisma.game.create.mock.calls[0][0].data.players.create;
    expect(players[0]).toMatchObject({
      modelName: 'default-model',
      accessBaseUrl: 'https://mock.invalid',
      accessUsesDefault: true,
    });
    expect(players[1]).toMatchObject({
      modelName: 'custom-model',
      accessBaseUrl: 'https://custom.invalid',
      accessUsesDefault: false,
    });
    for (const player of players) {
      expect(player).not.toHaveProperty('apiKey');
      expect(player).not.toHaveProperty('apiKeyCiphertext');
    }
  });

  it('使用条件状态更新抢占启动权', async () => {
    const { service, prisma, broadcaster } = createService();
    const initialGame = { id: 'game-1', status: GAME_STATUSES.INITIALIZED };
    const runningGame = { ...initialGame, status: GAME_STATUSES.RUNNING };
    prisma.game.findUnique.mockResolvedValue(initialGame);
    prisma.game.updateMany.mockResolvedValue({ count: 1 });
    prisma.game.findUniqueOrThrow.mockResolvedValue(runningGame);

    await expect(service.startGame('game-1')).resolves.toBe(runningGame);

    expect(prisma.game.updateMany).toHaveBeenCalledWith({
      where: { id: 'game-1', status: GAME_STATUSES.INITIALIZED },
      data: { status: GAME_STATUSES.RUNNING },
    });
    expect(broadcaster.getOrCreate).toHaveBeenCalledWith('game-1');
  });

  it('并发启动未抢到状态时不创建广播流', async () => {
    const { service, prisma, broadcaster } = createService();
    prisma.game.findUnique
      .mockResolvedValueOnce({ id: 'game-1', status: GAME_STATUSES.INITIALIZED })
      .mockResolvedValueOnce({ status: GAME_STATUSES.RUNNING });
    prisma.game.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.startGame('game-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(broadcaster.getOrCreate).not.toHaveBeenCalled();
  });

  it('取消对局后发送终态并关闭广播流', async () => {
    const { service, gameExecutor, broadcaster } = createService();
    jest
      .spyOn(service, 'getGameById')
      .mockResolvedValue({ id: 'game-1', status: GAME_STATUSES.RUNNING } as never);

    await expect(service.cancelGame('game-1')).resolves.toBe(true);

    expect(gameExecutor.abortGame).toHaveBeenCalledWith('game-1');
    expect(broadcaster.emit).toHaveBeenCalledWith('game-1', {
      type: 'game.finished',
      winner: 'unknown',
    });
    expect(broadcaster.complete).toHaveBeenCalledWith('game-1');
  });
});
