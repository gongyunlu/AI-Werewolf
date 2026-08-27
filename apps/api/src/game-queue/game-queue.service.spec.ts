import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { GameQueueService } from './game-queue.service';

describe('GameQueueService', () => {
  it('同一对局只允许执行一次', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue({ id: 'game-1' }),
      close: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [GameQueueService, { provide: getQueueToken('game-queue'), useValue: queue }],
    }).compile();
    const service = moduleRef.get(GameQueueService);

    await expect(service.addGameJob('game-1')).resolves.toBe('game-1');
    expect(queue.add).toHaveBeenCalledWith(
      'run-game',
      { gameId: 'game-1' },
      expect.objectContaining({ jobId: 'game-1', attempts: 1 }),
    );
    expect(queue.add.mock.calls[0][2]).not.toHaveProperty('backoff');
  });
});
