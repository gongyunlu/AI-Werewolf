import { firstValueFrom } from 'rxjs';
import { GameStreamController } from './game-stream.controller';
import { SseBroadcasterService } from '../sse/sse-broadcaster.service';
import { EventBusService } from '../event-bus/event-bus.service';

describe('观战持久快照', () => {
  it('结束局清理内存后仍先返回完整已提交历史，而不是只有终局通知', async () => {
    const event = {
      id: 'event-1',
      gameId: 'game-1',
      sequence: 1,
      actionType: 'speech',
      visibility: 'public',
      actorId: 'player-1',
      content: { speech: '已经提交的完整发言', sceneId: 'speech-1' },
    };
    const prisma = {
      game: {
        findUnique: jest.fn().mockResolvedValue({ status: 'finished', winnerFaction: 'villager' }),
      },
      event: { findMany: jest.fn().mockResolvedValue([event]) },
      player: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const transactional = {
      ...prisma,
      $transaction: (run: (tx: typeof prisma) => unknown) => run(prisma),
    };
    const broadcaster = new SseBroadcasterService();
    const controller = new GameStreamController(
      broadcaster,
      new EventBusService(transactional as never, broadcaster),
    );
    const first = await firstValueFrom(await controller.stream('game-1'));
    expect(JSON.parse(first.data as string)).toMatchObject({
      type: 'connection.ready',
      snapshot: [expect.objectContaining({ eventId: 'event-1', content: '已经提交的完整发言' })],
      gameFinished: { winner: 'villager' },
    });
  });
});
