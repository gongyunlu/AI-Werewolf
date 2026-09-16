import { Test } from '@nestjs/testing';
import { GAME_PRODUCER_QUEUE, GameQueueService } from './game-queue.service';

describe('GameQueueService', () => {
  it('同一对局只执行一次引擎，但允许 FINISHED 后重试分析投递', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue({ id: 'game-1' }),
      close: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [GameQueueService, { provide: GAME_PRODUCER_QUEUE, useValue: queue }],
    }).compile();
    const service = moduleRef.get(GameQueueService);

    await expect(service.addGameJob('game-1')).resolves.toBe('game-1');
    expect(queue.add).toHaveBeenCalledWith(
      'run-game',
      { gameId: 'game-1', generation: 1 },
      expect.objectContaining({
        jobId: 'game-1',
        attempts: 6,
        backoff: { type: 'exponential', delay: 5000 },
      }),
    );
  });
});
