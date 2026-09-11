import type { ConnectionReadyEvent, SseMessage } from './sse-event.types';
import { SseBroadcasterService } from './sse-broadcaster.service';
import { EventBusService } from '../event-bus/event-bus.service';

describe('SseBroadcasterService recovery', () => {
  it('把历史折叠为快照并从水位后继续实时事件', () => {
    const service = new SseBroadcasterService();
    service.getOrCreate('game-1');
    service.emit('game-1', {
      type: 'scene.open',
      sceneId: 'scene-1',
      sceneType: 'speech',
      visibility: 'public',
      actorId: 'player-1',
    });
    service.emit('game-1', {
      type: 'scene.append',
      sceneId: 'scene-1',
      contentType: 'thinking',
      token: '思考',
    });
    service.emit('game-1', {
      type: 'scene.append',
      sceneId: 'scene-1',
      contentType: 'content',
      token: '发言',
    });
    service.emit('game-1', {
      type: 'scene.close',
      sceneId: 'scene-1',
      thinkingDurationMs: 10,
      contentDurationMs: 20,
    });
    service.emit('game-1', {
      type: 'player.died',
      playerId: 'player-2',
      deathDay: 1,
      deathCause: 'execution',
    });

    const messages: SseMessage[] = [];
    const subscription = service.getRecoveryStream('game-1').subscribe((message) => {
      messages.push(message);
    });

    const ready = messages[0] as ConnectionReadyEvent;
    expect(ready).toEqual(
      expect.objectContaining({
        type: 'connection.ready',
        lastSequence: 5,
        playerDeaths: [{ playerId: 'player-2', deathDay: 1, deathCause: 'execution' }],
      }),
    );
    expect(ready.snapshot).toEqual([
      expect.objectContaining({
        sceneId: 'scene-1',
        thinking: '思考',
        content: '发言',
        status: 'closed',
        thinkingDurationMs: 10,
        contentDurationMs: 20,
      }),
    ]);

    service.emit('game-1', {
      type: 'scene.open',
      sceneId: 'scene-2',
      sceneType: 'judge',
      visibility: 'public',
    });
    expect(messages[1]).toEqual(expect.objectContaining({ sequence: 6, sceneId: 'scene-2' }));

    subscription.unsubscribe();
  });

  it('保留当前未关闭场景的已生成内容', () => {
    const service = new SseBroadcasterService();
    service.getOrCreate('game-1');
    service.emit('game-1', {
      type: 'scene.open',
      sceneId: 'active-scene',
      sceneType: 'speech',
      visibility: 'public',
    });
    service.emit('game-1', {
      type: 'scene.append',
      sceneId: 'active-scene',
      contentType: 'content',
      token: '生成中',
    });

    let ready: ConnectionReadyEvent | undefined;
    const subscription = service.getRecoveryStream('game-1').subscribe((message) => {
      if (message.type === 'connection.ready') ready = message;
    });

    expect(ready?.snapshot[0]).toEqual(
      expect.objectContaining({ status: 'active', content: '生成中' }),
    );
    subscription.unsubscribe();
  });

  it('历史场景恢复后，节点重入不会重复卡片或追加同一段正文', async () => {
    const service = new SseBroadcasterService();
    const bus = new EventBusService(
      {
        event: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'event-1',
              gameId: 'game-1',
              sequence: 1,
              actionType: 'speech',
              actorId: 'player-1',
              visibility: 'public',
              content: {
                speech: '已提交的发言',
                thinking: '已提交的思考',
                sceneId: 'scene-1',
                sceneType: 'speech',
              },
            },
          ]),
        },
        player: { findMany: jest.fn().mockResolvedValue([]) },
      } as never,
      service,
    );
    await bus.restore('game-1');
    const messages: SseMessage[] = [];
    const subscription = service
      .getRecoveryStream('game-1')
      .subscribe((message) => messages.push(message));

    service.emit('game-1', {
      type: 'scene.open',
      sceneId: 'scene-1',
      sceneType: 'speech',
      visibility: 'public',
    });
    service.emit('game-1', {
      type: 'scene.append',
      sceneId: 'scene-1',
      contentType: 'thinking',
      token: '重复思考',
    });
    service.emit('game-1', {
      type: 'scene.append',
      sceneId: 'scene-1',
      contentType: 'content',
      token: '重复正文',
    });
    service.emit('game-1', {
      type: 'scene.close',
      sceneId: 'scene-1',
      thinkingDurationMs: 0,
      contentDurationMs: 0,
    });

    expect(messages).toHaveLength(1);
    const original = messages[0] as ConnectionReadyEvent;
    expect(original.snapshot).toEqual([
      expect.objectContaining({
        sceneId: 'scene-1',
        content: '已提交的发言',
        thinking: '已提交的思考',
      }),
    ]);

    service.emit('game-1', {
      type: 'scene.open',
      sceneId: 'scene-2',
      sceneType: 'speech',
      visibility: 'public',
    });
    service.emit('game-1', {
      type: 'scene.append',
      sceneId: 'scene-2',
      contentType: 'content',
      token: '新的发言',
    });
    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({
      type: 'scene.open',
      sceneId: 'scene-2',
      sequence: original.lastSequence + 1,
    });
    subscription.unsubscribe();

    const reconnectMessages: SseMessage[] = [];
    const reconnected = service
      .getRecoveryStream('game-1')
      .subscribe((message) => reconnectMessages.push(message));
    expect((reconnectMessages[0] as ConnectionReadyEvent).snapshot).toEqual([
      expect.objectContaining({ sceneId: 'scene-1', content: '已提交的发言' }),
      expect.objectContaining({ sceneId: 'scene-2', content: '新的发言', status: 'active' }),
    ]);
    reconnected.unsubscribe();
  });

  it('对局完成清理后，相同场景 ID 不会被旧去重记录屏蔽', async () => {
    const service = new SseBroadcasterService();
    const bus = new EventBusService(
      {
        event: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'event-1',
              gameId: 'game-1',
              sequence: 1,
              actionType: 'speech',
              actorId: 'player-1',
              visibility: 'public',
              content: { speech: '历史发言', sceneId: 'scene-1', sceneType: 'speech' },
            },
          ]),
        },
        player: { findMany: jest.fn().mockResolvedValue([]) },
      } as never,
      service,
    );
    await bus.restore('game-1');
    service.complete('game-1');
    service.getOrCreate('game-1');
    service.emit('game-1', {
      type: 'scene.open',
      sceneId: 'scene-1',
      sceneType: 'speech',
      visibility: 'public',
      initialContent: '新的内容',
    });

    let ready: ConnectionReadyEvent | undefined;
    const subscription = service.getRecoveryStream('game-1').subscribe((message) => {
      if (message.type === 'connection.ready') ready = message;
    });

    expect(ready?.snapshot).toEqual([expect.objectContaining({ content: '新的内容' })]);
    subscription.unsubscribe();
  });
});
