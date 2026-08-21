import { useEffect, useRef, useCallback } from 'react';
import { apiClient } from '@/lib/api-client';
import type { SseMessage } from '@/types/sse';

const RETRY_DELAYS = [1000, 2000, 4000, 8000];
const MAX_RETRIES = RETRY_DELAYS.length;

interface UseGameStreamOptions {
  enabled?: boolean;
}

export function useGameStream(
  gameId: string,
  perspective: string,
  onMessage: (msg: SseMessage) => void,
  options: UseGameStreamOptions = {},
) {
  const { enabled = true } = options;
  const retryCount = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endedRef = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const connect = useCallback(() => {
    if (!enabledRef.current) return;
    // 已收到 game.finished：对局结束，不再重连
    if (endedRef.current) return;
    if (retryCount.current >= MAX_RETRIES) {
      console.error(`SSE 连接失败，已达最大重试次数 ${MAX_RETRIES}`);
      return;
    }

    // sessionStorage 在隐私模式/配额满时会抛异常，忽略并回退到 0
    let lastSequence = 0;
    try {
      lastSequence = Number(sessionStorage.getItem(`sse-seq-${gameId}`) ?? '0');
    } catch {
      // 忽略读取失败
    }

    const es = apiClient.createSSEConnection(gameId, { lastSequence, perspective });
    esRef.current = es;

    es.addEventListener('message', (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as SseMessage;
      retryCount.current = 0;
      if (msg.type === 'game.finished') {
        endedRef.current = true;
        es.close();
      } else if (msg.type !== 'connection.ready') {
        try {
          sessionStorage.setItem(
            `sse-seq-${gameId}`,
            String((msg as { sequence?: number }).sequence ?? 0),
          );
        } catch {
          // 忽略写入失败，仅影响断线续传
        }
      }
      onMessage(msg);
    });

    es.addEventListener('error', () => {
      es.close();
      // 对局已正常结束导致的服务端关闭，无需重连
      if (endedRef.current) return;
      const delay = RETRY_DELAYS[Math.min(retryCount.current, RETRY_DELAYS.length - 1)];
      retryCount.current += 1;
      retryTimerRef.current = setTimeout(connect, delay);
    });
  }, [gameId, perspective, onMessage]);

  useEffect(() => {
    if (!enabled) return;
    connect();
    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      esRef.current?.close();
      retryCount.current = 0;
      endedRef.current = false;
    };
  }, [connect, enabled]);
}
