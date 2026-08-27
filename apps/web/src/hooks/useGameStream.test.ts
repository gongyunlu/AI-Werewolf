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

  it('connection.ready 不会清空断线重试计数', async () => {
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

    expect(createConnection).toHaveBeenCalledTimes(4);
    unmount();
  });
});
