import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSceneEngine } from './useSceneEngine';

describe('useSceneEngine', () => {
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
