import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSceneEngine } from './useSceneEngine';
import type { EventsCommittedEvent, SceneSnapshot, SseMessage } from '@/types/sse';

function finalScene(eventId: string, sceneId: string, eventSequence = 1): SceneSnapshot {
  return {
    eventId,
    eventSequence,
    sceneId,
    sceneType: 'speech',
    visibility: 'public',
    thinking: '最终思考',
    content: '最终完整正文',
    status: 'closed',
    thinkingDurationMs: 0,
    contentDurationMs: 0,
  };
}
function committed(scenes: SceneSnapshot[]): EventsCommittedEvent {
  return {
    type: 'events.committed',
    sequence: 10,
    deliveryKey: 'batch/one',
    firstSequence: 1,
    lastSequence: scenes.length,
    scenes,
    playerDeaths: [],
  };
}

describe('useSceneEngine', () => {
  it.each([
    { type: 'game.finished', winner: 'unknown' },
    { ...committed([]), gameFinished: { winner: 'villager' } },
  ] satisfies SseMessage[])(
    '收到 $type 终态后清除生成中预览，迟到片段和关闭不能恢复它',
    (message) => {
      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useSceneEngine('god'));
        act(() => {
          result.current.handleMessage(committed([finalScene('saved', 'saved-scene')]));
          result.current.handleMessage({
            type: 'scene.open',
            sequence: 11,
            sceneId: 'unfinished',
            sceneType: 'vote',
            visibility: 'public',
            initialContent: '未提交的投票预览',
          });
          result.current.handleMessage({
            type: 'scene.close',
            sequence: 12,
            sceneId: 'unfinished',
            thinkingDurationMs: 10,
            contentDurationMs: 20,
          });
          result.current.handleMessage(message);
        });
        expect(result.current.state.gameOver).toBe(true);
        expect(result.current.state.activeScene).toBeNull();
        act(() => {
          result.current.handleMessage({
            type: 'scene.append',
            sequence: 13,
            sceneId: 'unfinished',
            contentType: 'content',
            token: '迟到片段',
          });
          result.current.handleMessage({
            type: 'scene.close',
            sequence: 14,
            sceneId: 'unfinished',
            thinkingDurationMs: 10,
            contentDurationMs: 20,
          });
          vi.runAllTimers();
        });
        expect(result.current.state.activeScene).toBeNull();
        expect(result.current.state.closedScenes.map((scene) => scene.eventId)).toEqual(['saved']);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('最终卡片接收迟到耗时，再次交付不重置耗时或追加卡片', () => {
    const { result } = renderHook(() => useSceneEngine('god'));
    act(() => {
      result.current.handleMessage(committed([finalScene('e', 's')]));
      result.current.handleMessage({
        type: 'scene.close',
        sequence: 11,
        sceneId: 's',
        eventId: 'e',
        thinkingDurationMs: 12,
        contentDurationMs: 34,
      });
      result.current.handleMessage(committed([finalScene('e', 's')]));
    });
    expect(result.current.state.closedScenes).toEqual([
      expect.objectContaining({ eventId: 'e', thinkingDurationMs: 12, contentDurationMs: 34 }),
    ]);
  });

  it('正文即时预览，最终 Event 替换同一场景，重复补送不追加正文或思考', () => {
    const { result } = renderHook(() => useSceneEngine('god'));
    act(() => {
      result.current.handleMessage({
        type: 'scene.open',
        sequence: 1,
        sceneId: 's',
        attemptId: 'a',
        sceneType: 'speech',
        visibility: 'public',
      });
      result.current.handleMessage({
        type: 'scene.append',
        sequence: 2,
        sceneId: 's',
        attemptId: 'a',
        contentType: 'content',
        token: '半句',
      });
    });
    expect(result.current.state.activeScene?.content).toBe('半句');
    expect(result.current.state.closedScenes).toHaveLength(0);
    act(() => {
      result.current.handleMessage(committed([finalScene('event-1', 's')]));
      result.current.handleMessage(committed([finalScene('event-1', 's')]));
    });
    expect(result.current.state.activeScene).toBeNull();
    expect(result.current.state.closedScenes).toHaveLength(1);
    expect(result.current.state.closedScenes[0]).toMatchObject({
      eventId: 'event-1',
      content: '最终完整正文',
      thinking: '最终思考',
    });
  });

  it('旧场景最终结果迟到时按事件顺序插入，不抢占当前发言', () => {
    const { result } = renderHook(() => useSceneEngine('god'));
    act(() => {
      result.current.handleMessage(committed([finalScene('event-2', 's2', 2)]));
      result.current.handleMessage({
        type: 'scene.open',
        sequence: 11,
        sceneId: 'active',
        attemptId: 'a',
        sceneType: 'speech',
        visibility: 'public',
      });
      result.current.handleMessage(committed([finalScene('event-1', 's1', 1)]));
    });
    expect(result.current.state.activeScene?.sceneId).toBe('active');
    expect(result.current.state.closedScenes.map((scene) => scene.eventId)).toEqual([
      'event-1',
      'event-2',
    ]);
  });

  it('同场景新尝试替换半段，旧尝试的 append 和 close 都不能污染新正文', () => {
    const { result } = renderHook(() => useSceneEngine('god'));
    act(() => {
      result.current.handleMessage({
        type: 'scene.open',
        sequence: 1,
        sceneId: 's',
        attemptId: 'old',
        sceneType: 'speech',
        visibility: 'public',
        initialContent: '旧半段',
      });
      result.current.handleMessage({
        type: 'scene.open',
        sequence: 2,
        sceneId: 's',
        attemptId: 'new',
        sceneType: 'speech',
        visibility: 'public',
        initialContent: '新正文',
      });
      result.current.handleMessage({
        type: 'scene.append',
        sequence: 3,
        sceneId: 's',
        attemptId: 'old',
        contentType: 'content',
        token: '迟到',
      });
      result.current.handleMessage({
        type: 'scene.close',
        sequence: 4,
        sceneId: 's',
        attemptId: 'old',
        thinkingDurationMs: 0,
        contentDurationMs: 0,
      });
    });
    expect(result.current.state.activeScene).toMatchObject({ attemptId: 'new', content: '新正文' });
    expect(result.current.state.closedScenes).toHaveLength(0);
  });

  it('历史场景 ID 重名时不同 Event 都保留，重投其中一条不删除另一条', () => {
    const { result } = renderHook(() => useSceneEngine('god'));
    act(() => {
      result.current.handleMessage({
        type: 'connection.ready',
        gameId: 'g',
        lastSequence: 0,
        playerDeaths: [],
        snapshot: [finalScene('e1', '旧PK场景', 1), finalScene('e2', '旧PK场景', 2)],
      });
      result.current.handleMessage(committed([finalScene('e1', '旧PK场景', 1)]));
    });
    expect(result.current.state.closedScenes.map((scene) => scene.eventId)).toEqual(['e1', 'e2']);
  });

  it('批次以一次状态更新合并全部事件，重复整批不会增加卡片', () => {
    const { result } = renderHook(() => useSceneEngine('god'));
    const batch = committed([finalScene('e1', 'v1', 1), finalScene('e2', 'v2', 2)]);
    act(() => result.current.handleMessage(batch));
    expect(result.current.state.closedScenes.map((scene) => scene.eventId)).toEqual(['e1', 'e2']);
    act(() => result.current.handleMessage(batch));
    expect(result.current.state.closedScenes).toHaveLength(2);
  });

  it('切流后的旧 epoch 和已提交场景的晚到预览不会覆盖最终内容', () => {
    const { result } = renderHook(() => useSceneEngine('god'));
    act(() => {
      result.current.handleMessage({
        type: 'connection.ready',
        gameId: 'g',
        streamId: 'new',
        lastSequence: 0,
        playerDeaths: [],
        snapshot: [finalScene('e', 's')],
      });
      result.current.handleMessage({
        type: 'scene.open',
        streamId: 'old',
        sequence: 1,
        sceneId: 'other',
        sceneType: 'speech',
        visibility: 'public',
      });
      result.current.handleMessage({
        type: 'scene.open',
        streamId: 'new',
        sequence: 2,
        sceneId: 's',
        sceneType: 'speech',
        visibility: 'public',
        initialContent: '迟到旧预览',
      });
    });
    expect(result.current.state.activeScene).toBeNull();
    expect(result.current.state.closedScenes).toHaveLength(1);
    expect(result.current.state.closedScenes[0].content).toBe('最终完整正文');
  });

  it('同一关闭消息重复到达，只保留一张卡片', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useSceneEngine('god'));
      act(() => {
        result.current.handleMessage({
          type: 'scene.open',
          sequence: 1,
          sceneId: 'speech',
          sceneType: 'speech',
          visibility: 'public',
          initialContent: '完整正文',
        });
        const close = {
          type: 'scene.close' as const,
          sequence: 2,
          sceneId: 'speech',
          thinkingDurationMs: 0,
          contentDurationMs: 0,
        };
        result.current.handleMessage(close);
        result.current.handleMessage({ ...close, sequence: 3 });
        vi.runAllTimers();
      });
      expect(result.current.state.closedScenes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('通过 connection.ready 快速恢复关闭场景和活动场景', () => {
    const { result } = renderHook(() => useSceneEngine('god'));

    act(() => {
      result.current.handleMessage({
        type: 'connection.ready',
        gameId: 'game-1',
        lastSequence: 8,
        playerDeaths: [],
        snapshot: [
          {
            sceneId: 'closed',
            sceneType: 'judge',
            visibility: 'public',
            thinking: '',
            content: '天亮了',
            status: 'closed',
            thinkingDurationMs: 0,
            contentDurationMs: 0,
          },
          {
            sceneId: 'active',
            sceneType: 'speech',
            visibility: 'public',
            actorId: 'player-1',
            thinking: '分析中',
            content: '我是',
            status: 'active',
            thinkingDurationMs: 0,
            contentDurationMs: 0,
          },
        ],
      });
    });

    expect(result.current.state.closedScenes).toHaveLength(1);
    expect(result.current.state.closedScenes[0].content).toBe('天亮了');
    expect(result.current.state.activeScene).toEqual(
      expect.objectContaining({ sceneId: 'active', thinking: '分析中', content: '我是' }),
    );
  });

  it('忽略不属于当前活动场景的关闭消息', () => {
    const { result } = renderHook(() => useSceneEngine('god'));

    act(() => {
      result.current.handleMessage({
        type: 'scene.open',
        sequence: 1,
        sceneId: 'scene-a',
        sceneType: 'speech',
        visibility: 'public',
      });
      result.current.handleMessage({
        type: 'scene.close',
        sequence: 2,
        sceneId: 'scene-b',
        thinkingDurationMs: 0,
        contentDurationMs: 0,
      });
    });

    expect(result.current.state.activeScene?.sceneId).toBe('scene-a');
    expect(result.current.state.closedScenes).toHaveLength(0);
  });
});
