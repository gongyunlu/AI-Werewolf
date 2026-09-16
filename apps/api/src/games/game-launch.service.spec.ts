import { GameLaunchService } from './game-launch.service';

describe('启动应用边界', () => {
  it('准备失败时不尝试投递', async () => {
    const failure = new Error('技能缺失');
    const games = { startGame: jest.fn().mockRejectedValue(failure) };
    const dispatch = { dispatch: jest.fn() };
    await expect(
      new GameLaunchService(games as never, dispatch as never).start('game'),
    ).rejects.toBe(failure);
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('投递错误原样抛出，已接受的意图交由数据库与扫描器保留', async () => {
    const failure = new Error('Redis 响应丢失');
    const games = { startGame: jest.fn().mockResolvedValue({ status: 'running' }) };
    const dispatch = { dispatch: jest.fn().mockRejectedValue(failure) };
    await expect(
      new GameLaunchService(games as never, dispatch as never).start('game'),
    ).rejects.toBe(failure);
  });
});
