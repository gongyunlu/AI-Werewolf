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
  const lastSequenceRef = useRef(0);
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

    const es = apiClient.createSSEConnection(gameId, { perspective });
    esRef.current = es;

    // 记录期望的下一个序列号
    let expectedSequence = lastSequenceRef.current;

    es.addEventListener('message', (e: MessageEvent) => {
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
          es.close();
          // 立即重连，从最后正确的序列号开始（存入 retryTimerRef 以便 unmount 时清理）
          retryTimerRef.current = setTimeout(() => connect(), 100);
          return;
        }
        expectedSequence = sequence;
        lastSequenceRef.current = sequence;
        retryCount.current = 0;
      }

      if (msg.type === 'game.finished') {
        endedRef.current = true;
        es.close();
      }

      onMessage(msg);
    });

    es.addEventListener('error', () => {
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
      retryCount.current = 0;
      endedRef.current = false;
    };
  }, [connect, enabled]);
}
