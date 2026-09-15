import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api-client';
import { useGameStream } from './useGameStream';

type EventListener = (event: MessageEvent) => void;

class FakeEventSource {
  private readonly listeners = new Map<string, EventListener[]>();

  readonly close = vi.fn();

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: 'message' | 'error', data = '') {
    const event = new MessageEvent(type, { data });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const readyMessage = JSON.stringify({
  type: 'connection.ready',
  gameId: 'game-1',
  lastSequence: 0,
  snapshot: [],
  playerDeaths: [],
});

async function disconnectAndAdvance(sources: FakeEventSource[], delay: number) {
  const source = sources.at(-1);
  expect(source).toBeDefined();
  act(() => {
    source?.emit('message', readyMessage);
    source?.emit('error');
  });
  await act(() => vi.advanceTimersByTimeAsync(delay));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useGameStream', () => {
  it('忽略无法解析的消息，保持连接可继续使用', () => {
    const source = new FakeEventSource();
    vi.spyOn(apiClient, 'createSSEConnection').mockReturnValue(source as unknown as EventSource);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onMessage = vi.fn();
    const { unmount } = renderHook(() => useGameStream('game-1', 'god', onMessage));

    act(() => source.emit('message', '{invalid json'));
    act(() => source.emit('message', readyMessage));

    expect(consoleError).toHaveBeenCalledWith('忽略无法解析的 SSE 消息', expect.any(SyntaxError));
    expect(onMessage).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('空握手不清空退避计数，达到上限后仍有间隔重连等待服务恢复', async () => {
    vi.useFakeTimers();
    const sources: FakeEventSource[] = [];
    const createConnection = vi.spyOn(apiClient, 'createSSEConnection').mockImplementation(() => {
      const source = new FakeEventSource();
      sources.push(source);
      return source as unknown as EventSource;
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { unmount } = renderHook(() => useGameStream('game-1', 'god', vi.fn()));

    await disconnectAndAdvance(sources, 1000);
    await disconnectAndAdvance(sources, 2000);
    await disconnectAndAdvance(sources, 4000);
    await disconnectAndAdvance(sources, 8000);

    expect(createConnection).toHaveBeenCalledTimes(5);
    await disconnectAndAdvance(sources, 7999);
    expect(createConnection).toHaveBeenCalledTimes(5);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(createConnection).toHaveBeenCalledTimes(6);
    unmount();
  });

  it('终局后 revision 变化不再重连', () => {
    const sources: FakeEventSource[] = [];
    const createConnection = vi.spyOn(apiClient, 'createSSEConnection').mockImplementation(() => {
      const source = new FakeEventSource();
      sources.push(source);
      return source as unknown as EventSource;
    });
    const { rerender } = renderHook(
      ({ revision }: { revision: string }) => useGameStream('game-1', 'god', vi.fn(), { revision }),
      { initialProps: { revision: 'running' } },
    );

    act(() => sources.at(-1)?.emit('message', readyMessage));
    act(() => {
      sources
        .at(-1)
        ?.emit(
          'message',
          JSON.stringify({ type: 'game.finished', sequence: 1, winner: 'villager' }),
        );
    });
    expect(sources[0].close).toHaveBeenCalled();

    // 对局结束时页面回读 DB 会把 status 从 running 换成 finished，revision 随之变化
    rerender({ revision: 'finished' });
    expect(createConnection).toHaveBeenCalledTimes(1);
  });
});
