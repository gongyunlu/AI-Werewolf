import { useCallback, useReducer, useRef } from 'react';
import type { SceneType, SceneVisibility, SseMessage } from '@/types/sse';

export interface ClosedScene {
  sceneId: string;
  sceneType: SceneType;
  visibility: SceneVisibility;
  actorId?: string;
  thinking: string;
  content: string;
  thinkingDurationMs: number;
  contentDurationMs: number;
  metadata?: Record<string, unknown>;
}

export interface ActiveScene {
  sceneId: string;
  sceneType: SceneType;
  visibility: SceneVisibility;
  actorId?: string;
  thinking: string;
  content: string;
  metadata?: Record<string, unknown>;
}

interface SceneState {
  closedScenes: ClosedScene[];
  activeScene: ActiveScene | null;
  gameOver: boolean;
  winner?: string;
}

type Action =
  | { type: 'SCENE_OPEN'; scene: ActiveScene }
  | { type: 'APPEND'; sceneId: string; token: string; contentType: 'thinking' | 'content' }
  | { type: 'SCENE_CLOSE'; closed: ClosedScene }
  | { type: 'GAME_OVER'; winner: string };

function reducer(state: SceneState, action: Action): SceneState {
  switch (action.type) {
    case 'SCENE_OPEN':
      return { ...state, activeScene: action.scene };
    case 'APPEND': {
      const active = state.activeScene;
      // 防御：append 只作用于当前活跃场景（断线重连等场景可能串号）
      if (!active || active.sceneId !== action.sceneId) return state;
      if (action.contentType === 'thinking') {
        return {
          ...state,
          activeScene: { ...active, thinking: active.thinking + action.token },
        };
      }
      return { ...state, activeScene: { ...active, content: active.content + action.token } };
    }
    case 'SCENE_CLOSE':
      return {
        ...state,
        activeScene: null,
        closedScenes: [...state.closedScenes, action.closed],
      };
    case 'GAME_OVER':
      return { ...state, gameOver: true, winner: action.winner };
    default:
      return state;
  }
}

const INITIAL_STATE: SceneState = {
  closedScenes: [],
  activeScene: null,
  gameOver: false,
};

/** 非流式场景关闭后最小停留时间（ms） */
const HOLD_UNTIL_MS: Record<string, number> = {
  judge: 2000,
  system: 1500,
  night_prompt: 2500,
  vote: 800,
  night_action: 1500,
  speech: 0,
  last_words: 0,
};

export function useSceneEngine(perspective: string) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const activeSceneRef = useRef<ActiveScene | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCloseRef = useRef<ClosedScene | null>(null);

  const flushPendingClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (pendingCloseRef.current) {
      activeSceneRef.current = null;
      dispatch({ type: 'SCENE_CLOSE', closed: pendingCloseRef.current });
      pendingCloseRef.current = null;
    }
  }, []);

  const handleMessage = useCallback(
    (msg: SseMessage) => {
      if (msg.type === 'scene.open') {
        // 如果有上一个 scene 的延迟关闭尚未完成，立即收尾
        flushPendingClose();

        // 闭眼视角只展示公开场景；过滤后的场景不登记 activeScene，
        // 其后续 scene.append / scene.close 因 sceneId 不匹配或无 activeScene 而被忽略
        if (perspective === 'villager' && msg.visibility !== 'public') {
          return;
        }

        const scene: ActiveScene = {
          sceneId: msg.sceneId,
          sceneType: msg.sceneType,
          visibility: msg.visibility,
          actorId: msg.actorId,
          thinking: '',
          content: msg.initialContent ?? '',
          metadata: msg.metadata,
        };
        activeSceneRef.current = scene;
        dispatch({ type: 'SCENE_OPEN', scene });
      } else if (msg.type === 'scene.append') {
        dispatch({
          type: 'APPEND',
          sceneId: msg.sceneId,
          token: msg.token,
          contentType: msg.contentType,
        });
        // 同步 ref，确保后续 scene.close 能拿到完整的思考/正文内容
        const active = activeSceneRef.current;
        if (active && active.sceneId === msg.sceneId) {
          activeSceneRef.current =
            msg.contentType === 'thinking'
              ? { ...active, thinking: active.thinking + msg.token }
              : { ...active, content: active.content + msg.token };
        }
      } else if (msg.type === 'scene.close') {
        const scene = activeSceneRef.current;
        if (!scene) return;

        const holdMs = HOLD_UNTIL_MS[scene.sceneType] ?? 0;
        const closed: ClosedScene = {
          sceneId: msg.sceneId,
          sceneType: scene.sceneType,
          visibility: scene.visibility,
          actorId: scene.actorId,
          thinking: scene.thinking,
          content: scene.content,
          thinkingDurationMs: msg.thinkingDurationMs,
          contentDurationMs: msg.contentDurationMs,
          metadata: scene.metadata,
        };

        // 记录待关闭场景，供 flushPendingClose 在新场景打开时立即收尾
        pendingCloseRef.current = closed;
        closeTimerRef.current = setTimeout(() => {
          activeSceneRef.current = null;
          dispatch({ type: 'SCENE_CLOSE', closed });
          pendingCloseRef.current = null;
        }, holdMs);
      } else if (msg.type === 'game.finished') {
        dispatch({ type: 'GAME_OVER', winner: msg.winner });
      }
    },
    [flushPendingClose, perspective],
  );

  return { state, handleMessage };
}
