import { ACTION_TYPES } from '@ai-werewolf/shared';
import type { Event } from '../generated/prisma/client';
import { SseBroadcasterService } from '../sse/sse-broadcaster.service';
import type { ConnectionReadyEvent, SseMessage } from '../sse/sse-event.types';
import { EventBusService } from './event-bus.service';

const gameId = 'game-1';

function createEvent(
  id: string,
  sequence: number,
  actionType: string,
  content: Event['content'],
): Event {
  return {
    id,
    gameId,
    sequence,
    actionType,
    content,
    day: 1,
    phase: 'speech',
    visibility: 'public',
    actorId: 'player-1',
    targetIds: [],
    createdAt: new Date('2026-09-10T00:00:00Z'),
  } as Event;
}

function snapshot(broadcaster: SseBroadcasterService): ConnectionReadyEvent {
  let ready!: ConnectionReadyEvent;
  const subscription = broadcaster.getRecoveryStream(gameId).subscribe((message) => {
    if (message.type === 'connection.ready') ready = message;
  });
  subscription.unsubscribe();
  return ready;
}

function createHarness(events: Event[]) {
  const prisma = {
    event: { findMany: jest.fn().mockResolvedValue(events) },
    player: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const broadcaster = new SseBroadcasterService();
  const service = new EventBusService(prisma as never, broadcaster);
  return { service, prisma, broadcaster };
}

describe('EventBusService persisted history recovery', () => {
  it('从已提交事件恢复历史发言，沿用原场景 ID、类型、正文与思考', async () => {
    const events = [
      createEvent('start-event', 1, ACTION_TYPES.GAME_STARTED, { playerCount: 6 }),
      createEvent('speech-event', 2, ACTION_TYPES.SPEECH, {
        speech: '昨天的票型已经说明问题。',
        thinking: '先核对已有查验。',
        sceneId: 'original-speech-scene',
        sceneType: 'last_words',
      }),
    ];
    const { service, prisma, broadcaster } = createHarness(events);

    await service.restore(gameId);

    expect(prisma.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { gameId },
        orderBy: { sequence: 'asc' },
      }),
    );
    expect(broadcaster.exists(gameId)).toBe(true);
    expect(snapshot(broadcaster).snapshot).toEqual([
      expect.objectContaining({ sceneId: 'start-event', sceneType: 'system', status: 'closed' }),
      expect.objectContaining({
        sceneId: 'original-speech-scene',
        sceneType: 'last_words',
        actorId: 'player-1',
        content: '昨天的票型已经说明问题。',
        thinking: '先核对已有查验。',
        status: 'closed',
      }),
    ]);
  });

  it('历史发言缺少场景元数据时仍恢复正文', async () => {
    const { service, broadcaster } = createHarness([
      createEvent('legacy-speech', 1, ACTION_TYPES.SPEECH, { speech: '旧记录的发言' }),
    ]);

    await service.restore(gameId);

    expect(snapshot(broadcaster).snapshot).toEqual([
      expect.objectContaining({
        sceneId: 'legacy-speech',
        sceneType: 'speech',
        content: '旧记录的发言',
      }),
    ]);
  });

  it('恢复流保留已死亡玩家的状态', async () => {
    const { service, prisma, broadcaster } = createHarness([]);
    prisma.player.findMany.mockResolvedValue([
      { id: 'player-2', isAlive: false, deathDay: 1, deathCause: 'execution' },
    ] as never);

    await service.restore(gameId);

    expect(snapshot(broadcaster).playerDeaths).toEqual([
      { playerId: 'player-2', deathDay: 1, deathCause: 'execution' },
    ]);
  });

  it('投票事件实时出卡时把本轮思考补在正文之后，且只有一张卡片', async () => {
    const { service, broadcaster } = createHarness([]);
    const messages: SseMessage[] = [];
    broadcaster.getOrCreate(gameId).subscribe((message) => messages.push(message));

    await service.publish(
      createEvent('vote-event', 1, ACTION_TYPES.VOTE, {
        voterSeatNo: 1,
        targetSeatNo: 2,
        thinking: '2号首夜发言回避刀口，先归票他。',
      }),
    );

    expect(messages.map((message) => message.type)).toEqual([
      'scene.open',
      'scene.append',
      'scene.close',
    ]);
    expect(messages[1]).toMatchObject({
      sceneId: 'vote-event',
      contentType: 'thinking',
      token: '2号首夜发言回避刀口，先归票他。',
    });
  });

  it('正常实时发布仍由节点广播 speech，避免落库后增加第二张卡片', async () => {
    const { service, broadcaster } = createHarness([]);
    broadcaster.getOrCreate(gameId);

    await service.publish(
      createEvent('speech-event', 1, ACTION_TYPES.SPEECH, { speech: '实时发言' }),
    );

    expect(snapshot(broadcaster).snapshot).toEqual([]);
  });

  it('历史读取失败向调用方抛出，不能把空快照当成恢复成功', async () => {
    const { service, prisma } = createHarness([]);
    const error = new Error('history unavailable');
    prisma.event.findMany.mockRejectedValue(error);

    await expect(service.restore(gameId)).rejects.toBe(error);
  });
});
