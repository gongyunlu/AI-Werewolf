import { useEffect, useRef, useCallback } from 'react';
import { apiClient } from '@/lib/api-client';
import type { SseMessage } from '@/types/sse';

const RETRY_DELAYS = [1000, 2000, 4000, 8000];

interface UseGameStreamOptions {
  enabled?: boolean;
  revision?: string;
}

export function useGameStream(
  gameId: string,
  perspective: string,
  onMessage: (msg: SseMessage) => void,
  options: UseGameStreamOptions = {},
) {
  const { enabled = true, revision } = options;
  const retryCount = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endedRef = useRef(false);
  const lastSequenceRef = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const connect = useCallback(() => {
    if (!enabledRef.current) return;
    // 已收到 game.finished：对局结束，不再重连
    if (endedRef.current) return;
    esRef.current?.close();
    const es = apiClient.createSSEConnection(gameId, { perspective });
    esRef.current = es;

    // 记录期望的下一个序列号
    let expectedSequence = lastSequenceRef.current;

    es.addEventListener('message', (e: MessageEvent) => {
      if (esRef.current !== es || !enabledRef.current) return;
      let msg: SseMessage;
      try {
        msg = JSON.parse(e.data as string) as SseMessage;
      } catch (error) {
        console.error('忽略无法解析的 SSE 消息', error);
        return;
      }

      if (msg.type === 'connection.ready') {
        expectedSequence = msg.lastSequence;
        lastSequenceRef.current = msg.lastSequence;
        onMessage(msg);
        if (msg.gameFinished) {
          endedRef.current = true;
          es.close();
        }
        return;
      }

      const sequence = (msg as { sequence?: number }).sequence;

      if (sequence !== undefined) {
        if (sequence <= expectedSequence) return;

        // 检测漏帧：序列号跳号
        if (sequence > expectedSequence + 1) {
          console.warn(
            `[SSE 漏帧检测] 期望 sequence=${expectedSequence + 1}, 实际收到 ${sequence}，缺失 ${sequence - expectedSequence - 1} 条消息，立即重连`,
          );
          esRef.current = null;
          es.close();
          // 立即重连，从最后正确的序列号开始（存入 retryTimerRef 以便 unmount 时清理）
          retryTimerRef.current = setTimeout(() => connect(), 100);
          return;
        }
        expectedSequence = sequence;
        lastSequenceRef.current = sequence;
        retryCount.current = 0;
      }

      if (msg.type === 'game.finished' || (msg.type === 'events.committed' && msg.gameFinished)) {
        endedRef.current = true;
        es.close();
      }

      onMessage(msg);
    });

    es.addEventListener('error', () => {
      if (esRef.current !== es) return;
      esRef.current = null;
      es.close();
      // 对局已正常结束导致的服务端关闭，无需重连
      if (endedRef.current || !enabledRef.current) return;
      const delay = RETRY_DELAYS[Math.min(retryCount.current, RETRY_DELAYS.length - 1)];
      retryCount.current += 1;
      retryTimerRef.current = setTimeout(connect, delay);
    });
  }, [gameId, perspective, onMessage]);

  useEffect(() => {
    lastSequenceRef.current = 0;
    // 终局标记只在换局时清掉。对局结束时 status 变化同样会触发下面的重连 effect，
    // 若在那里复位，connect 就会绕过「已结束不再重连」的守卫再开一条连接。
    endedRef.current = false;
  }, [gameId]);

  useEffect(() => {
    if (!enabled) return;
    connect();
    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      esRef.current?.close();
      esRef.current = null;
      retryCount.current = 0;
    };
  }, [connect, enabled, revision]);
}
