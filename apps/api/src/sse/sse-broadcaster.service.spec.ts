import type { ConnectionReadyEvent, SseMessage } from './sse-event.types';
import { SseBroadcasterService } from './sse-broadcaster.service';

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
});
