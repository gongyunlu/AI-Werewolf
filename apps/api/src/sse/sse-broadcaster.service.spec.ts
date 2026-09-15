import type { ConnectionReadyEvent, SseMessage } from './sse-event.types';
import { SseBroadcasterService } from './sse-broadcaster.service';
import { EventBusService } from '../event-bus/event-bus.service';
import type { PersistedGameSnapshot } from '../event-bus/event-bus.service';

describe('SseBroadcasterService recovery', () => {
  it('旧 created 快照返回时，不删除刚被引擎绑定的流', async () => {
    const service = new SseBroadcasterService();
    let resolve!: (value: PersistedGameSnapshot) => void;
    service
      .getRecoveryStream(
        'g',
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .subscribe();
    const execution = service.forExecution('g');
    execution.emit('g', {
      type: 'scene.open',
      sceneId: 's',
      attemptId: 'a',
      sceneType: 'speech',
      visibility: 'public',
    });
    resolve({ snapshot: [], playerDeaths: [], gameStatus: 'created' });
    await new Promise(setImmediate);
    execution.emit('g', {
      type: 'scene.append',
      sceneId: 's',
      attemptId: 'a',
      contentType: 'content',
      token: '开局首段',
    });
    let ready: ConnectionReadyEvent | undefined;
    const subscription = service.getRecoveryStream('g').subscribe((message) => {
      if (message.type === 'connection.ready') ready = message;
    });
    expect(ready?.snapshot).toEqual([expect.objectContaining({ content: '开局首段' })]);
    subscription.unsubscribe();
  });

  it('待恢复快照吸收查询期间的旧预览水位，不重新显示已中断半句', async () => {
    const service = new SseBroadcasterService();
    let resolve!: (value: PersistedGameSnapshot) => void;
    const load = jest
      .fn<Promise<PersistedGameSnapshot>, []>()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue({ snapshot: [], playerDeaths: [], gameStatus: 'pending_recovery' });
    const messages: SseMessage[] = [];
    service.getRecoveryStream('g', load).subscribe((message) => messages.push(message));
    service.emit('g', {
      type: 'scene.open',
      sceneId: 's',
      attemptId: 'old',
      sceneType: 'speech',
      visibility: 'public',
    });
    service.emit('g', {
      type: 'scene.append',
      sceneId: 's',
      attemptId: 'old',
      contentType: 'content',
      token: '旧半句',
    });
    service.complete('g');
    resolve({ snapshot: [], playerDeaths: [], gameStatus: 'running' });
    await new Promise(setImmediate);
    expect(messages).toEqual([
      expect.objectContaining({
        type: 'connection.ready',
        gameStatus: 'pending_recovery',
        snapshot: [],
        lastSequence: 2,
      }),
    ]);
  });

  it('提交先于 close 时只补齐耗时，重复最终消息不清空耗时或增加场景', () => {
    const service = new SseBroadcasterService();
    const messages: SseMessage[] = [];
    const subscription = service
      .getRecoveryStream('g')
      .subscribe((message) => messages.push(message));
    service.emit('g', {
      type: 'scene.open',
      sceneId: 's',
      attemptId: 'a',
      sceneType: 'speech',
      visibility: 'public',
    });
    const committed = {
      type: 'events.committed' as const,
      deliveryKey: 'event/e',
      firstSequence: 1,
      lastSequence: 1,
      playerDeaths: [],
      scenes: [
        {
          sceneId: 's',
          eventId: 'e',
          eventSequence: 1,
          sceneType: 'speech' as const,
          visibility: 'public' as const,
          status: 'closed' as const,
          thinking: '',
          content: '最终正文',
          thinkingDurationMs: 0,
          contentDurationMs: 0,
        },
      ],
    };
    service.emitCommitted('g', committed);
    service.emit('g', {
      type: 'scene.close',
      sceneId: 's',
      attemptId: 'old',
      thinkingDurationMs: 999,
      contentDurationMs: 999,
    });
    service.emit('g', {
      type: 'scene.close',
      sceneId: 's',
      attemptId: 'a',
      thinkingDurationMs: 12,
      contentDurationMs: 34,
    });
    expect(messages.at(-1)).toMatchObject({
      type: 'scene.close',
      eventId: 'e',
      thinkingDurationMs: 12,
      contentDurationMs: 34,
    });
    service.emitCommitted('g', committed);
    let ready: ConnectionReadyEvent | undefined;
    const recovery = service.getRecoveryStream('g').subscribe((message) => {
      if (message.type === 'connection.ready') ready = message;
    });
    expect(ready?.snapshot).toEqual([
      expect.objectContaining({
        eventId: 'e',
        content: '最终正文',
        thinkingDurationMs: 12,
        contentDurationMs: 34,
      }),
    ]);
    subscription.unsubscribe();
    recovery.unsubscribe();
  });

  it('重连快照保留已提交场景的真实耗时，不用投影的零值覆盖', async () => {
    const service = new SseBroadcasterService();
    service.getOrCreate('g');
    service.emit('g', {
      type: 'scene.open',
      sceneId: 's',
      attemptId: 'a',
      sceneType: 'speech',
      visibility: 'public',
    });
    service.emit('g', {
      type: 'scene.append',
      sceneId: 's',
      attemptId: 'a',
      contentType: 'content',
      token: '发言',
    });
    service.emit('g', {
      type: 'scene.close',
      sceneId: 's',
      attemptId: 'a',
      thinkingDurationMs: 12,
      contentDurationMs: 34,
    });
    service.emitCommitted('g', {
      type: 'events.committed',
      deliveryKey: 'event/e',
      firstSequence: 1,
      lastSequence: 1,
      playerDeaths: [],
      scenes: [
        {
          sceneId: 's',
          eventId: 'e',
          eventSequence: 1,
          sceneType: 'speech' as const,
          visibility: 'public' as const,
          status: 'closed' as const,
          thinking: '',
          content: '发言',
          thinkingDurationMs: 0,
          contentDurationMs: 0,
        },
      ],
    });

    let ready: ConnectionReadyEvent | undefined;
    const subscription = service
      .getRecoveryStream('g', async () => ({
        snapshot: [
          {
            sceneId: 's',
            eventId: 'e',
            eventSequence: 1,
            sceneType: 'speech' as const,
            visibility: 'public' as const,
            status: 'closed' as const,
            thinking: '',
            content: '发言',
            thinkingDurationMs: 0,
            contentDurationMs: 0,
          },
        ],
        playerDeaths: [],
        gameStatus: 'running',
      }))
      .subscribe((message) => {
        if (message.type === 'connection.ready') ready = message;
      });
    await new Promise(setImmediate);

    expect(ready?.snapshot).toEqual([
      expect.objectContaining({ eventId: 'e', thinkingDurationMs: 12, contentDurationMs: 34 }),
    ]);
    subscription.unsubscribe();
  });

  it('结束局快照发送完毕后释放临时流', async () => {
    const service = new SseBroadcasterService();
    service
      .getRecoveryStream('g', async () => ({
        snapshot: [],
        playerDeaths: [],
        gameStatus: 'finished',
        gameFinished: { winner: 'villager' },
      }))
      .subscribe();
    await new Promise(setImmediate);
    expect(service.exists('g')).toBe(false);
  });

  it('数据库读取期间的片段在冻结进度之后补齐，重连不调用生成器', async () => {
    const service = new SseBroadcasterService();
    service.getOrCreate('g');
    service.emit('g', {
      type: 'scene.open',
      sceneId: 's',
      attemptId: 'a',
      sceneType: 'speech',
      visibility: 'public',
    });
    service.emit('g', {
      type: 'scene.append',
      sceneId: 's',
      attemptId: 'a',
      contentType: 'content',
      token: '前半',
    });
    let resolve!: (snapshot: PersistedGameSnapshot) => void;
    const load = jest.fn(
      () =>
        new Promise<PersistedGameSnapshot>((done) => {
          resolve = done;
        }),
    );
    const messages: SseMessage[] = [];
    const subscription = service
      .getRecoveryStream('g', load)
      .subscribe((message) => messages.push(message));
    service.emit('g', {
      type: 'scene.append',
      sceneId: 's',
      attemptId: 'a',
      contentType: 'content',
      token: '后半',
    });
    resolve({ snapshot: [], playerDeaths: [], gameStatus: 'running', eventWatermark: 0 });
    await new Promise(setImmediate);
    expect(messages[0]).toMatchObject({
      type: 'connection.ready',
      lastSequence: 2,
      snapshot: [expect.objectContaining({ content: '前半', attemptId: 'a' })],
    });
    expect(messages[1]).toMatchObject({ type: 'scene.append', sequence: 3, token: '后半' });
    expect(load).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
  });

  it('新尝试替换旧半段，旧尝试片段和旧执行回调均被拒绝', () => {
    const service = new SseBroadcasterService();
    const oldExecution = service.forExecution('g');
    oldExecution.emit('g', {
      type: 'scene.open',
      sceneId: 's',
      attemptId: 'old',
      sceneType: 'speech',
      visibility: 'public',
    });
    oldExecution.emit('g', {
      type: 'scene.append',
      sceneId: 's',
      attemptId: 'old',
      token: '旧半段',
      contentType: 'content',
    });
    service.emit('g', {
      type: 'scene.open',
      sceneId: 's',
      attemptId: 'new',
      sceneType: 'speech',
      visibility: 'public',
    });
    oldExecution.emit('g', {
      type: 'scene.append',
      sceneId: 's',
      attemptId: 'old',
      token: '迟到',
      contentType: 'content',
    });
    const messages: SseMessage[] = [];
    const subscription = service
      .getRecoveryStream('g')
      .subscribe((message) => messages.push(message));
    expect(messages[0]).toMatchObject({
      snapshot: [expect.objectContaining({ attemptId: 'new', content: '' })],
    });
    service.complete('g');
    service.getOrCreate('g');
    oldExecution.emit('g', {
      type: 'scene.open',
      sceneId: 's',
      attemptId: 'late',
      sceneType: 'speech',
      visibility: 'public',
    });
    const restored: SseMessage[] = [];
    const next = service.getRecoveryStream('g').subscribe((message) => restored.push(message));
    expect(restored[0]).toMatchObject({ snapshot: [] });
    subscription.unsubscribe();
    next.unsubscribe();
  });

  it('取消信号拒绝迟到进度，已提交最终结果不受游戏取消影响', () => {
    const service = new SseBroadcasterService();
    const controller = new AbortController();
    const execution = service.forExecution('g', controller.signal);
    controller.abort();
    execution.emit('g', {
      type: 'scene.open',
      sceneId: 's',
      sceneType: 'speech',
      visibility: 'public',
    });
    const received: SseMessage[] = [];
    const subscription = service
      .getRecoveryStream('g')
      .subscribe((message) => received.push(message));
    expect(received[0]).toMatchObject({ snapshot: [] });
    service.emitCommitted('g', {
      type: 'events.committed',
      deliveryKey: 'event/e',
      firstSequence: 1,
      lastSequence: 1,
      scenes: [],
      playerDeaths: [],
    });
    expect(received[1].type).toBe('events.committed');
    subscription.unsubscribe();
  });

  it('读取期间产生终局但确认尚未完成，先发一致快照，再发完整终局消息', async () => {
    const service = new SseBroadcasterService();
    let resolve!: (value: PersistedGameSnapshot) => void;
    const messages: SseMessage[] = [];
    const subscription = service
      .getRecoveryStream(
        'g',
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .subscribe((message) => messages.push(message));
    service.emitCommitted('g', {
      type: 'events.committed',
      deliveryKey: 'event/end',
      firstSequence: 1,
      lastSequence: 1,
      scenes: [],
      playerDeaths: [],
      gameFinished: { winner: 'villager' },
    });
    resolve({ snapshot: [], playerDeaths: [], gameStatus: 'running' });
    await new Promise(setImmediate);
    expect(messages[0]).toMatchObject({ type: 'connection.ready', gameStatus: 'running' });
    expect((messages[0] as ConnectionReadyEvent).gameFinished).toBeUndefined();
    expect(messages[1]).toMatchObject({
      type: 'events.committed',
      gameFinished: { winner: 'villager' },
    });
    subscription.unsubscribe();
  });

  it('数据库读取期间流已关闭，再读完整终态后才结束连接', async () => {
    const service = new SseBroadcasterService();
    let resolve!: (value: PersistedGameSnapshot) => void;
    const load = jest
      .fn<Promise<PersistedGameSnapshot>, []>()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue({
        snapshot: [],
        playerDeaths: [],
        gameStatus: 'aborted',
        gameFinished: { winner: 'unknown' },
      });
    const messages: SseMessage[] = [];
    const closed = jest.fn();
    service
      .getRecoveryStream('g', load)
      .subscribe({ next: (message) => messages.push(message), complete: closed });
    service.complete('g');
    resolve({ snapshot: [], playerDeaths: [], gameStatus: 'running' });
    await new Promise(setImmediate);
    expect(load).toHaveBeenCalledTimes(2);
    expect(messages[0]).toMatchObject({
      gameStatus: 'aborted',
      gameFinished: { winner: 'unknown' },
    });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('查询期间恢复切换流，不把旧尝试快照发送到新连接', async () => {
    const service = new SseBroadcasterService();
    let resolve!: (value: PersistedGameSnapshot) => void;
    const load = jest
      .fn<Promise<PersistedGameSnapshot>, []>()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue({ snapshot: [], playerDeaths: [], gameStatus: 'running' });
    const messages: SseMessage[] = [];
    const completed = jest.fn();
    service
      .getRecoveryStream('g', load)
      .subscribe({ next: (message) => messages.push(message), complete: completed });
    service.complete('g');
    service.getOrCreate('g');
    resolve({ snapshot: [], playerDeaths: [], gameStatus: 'running' });
    await new Promise(setImmediate);
    expect(messages).toEqual([]);
    expect(completed).toHaveBeenCalled();
  });

  it('单次发言超过传输历史上限，重连仍保留完整未提交正文', () => {
    const service = new SseBroadcasterService();
    service.getOrCreate('long-speech');
    service.emit('long-speech', {
      type: 'scene.open',
      sceneId: 'speech',
      sceneType: 'speech',
      visibility: 'public',
    });
    for (let index = 0; index < 10005; index++) {
      service.emit('long-speech', {
        type: 'scene.append',
        sceneId: 'speech',
        contentType: 'content',
        token: '字',
      });
    }
    let ready: ConnectionReadyEvent | undefined;
    const subscription = service.getRecoveryStream('long-speech').subscribe((message) => {
      if (message.type === 'connection.ready') ready = message;
    });
    expect(ready?.snapshot).toEqual([
      expect.objectContaining({ sceneId: 'speech', content: '字'.repeat(10005), status: 'active' }),
    ]);
    subscription.unsubscribe();
  });

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
    service.emitCommitted('game-1', {
      type: 'events.committed',
      deliveryKey: 'event/execution',
      firstSequence: 1,
      lastSequence: 1,
      scenes: [],
      playerDeaths: [{ playerId: 'player-2', deathDay: 1, deathCause: 'execution' }],
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
