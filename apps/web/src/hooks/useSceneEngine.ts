import { useCallback, useReducer, useRef } from 'react';
import { RenderScheduler, HOLD_UNTIL_MS } from '@/lib/RenderScheduler';
import type { SceneType, SceneVisibility, SseMessage } from '@/types/sse';

export interface ClosedScene {
  sceneId: string;
  sceneType: SceneType;
  visibility: SceneVisibility;
  actorId?: string;
  fullContent: string;
  durationMs: number;
}

export interface ActiveScene {
  sceneId: string;
  sceneType: SceneType;
  visibility: SceneVisibility;
  actorId?: string;
}

interface SceneState {
  closedScenes: ClosedScene[];
  activeScene: ActiveScene | null;
  displayText: string;
  gameOver: boolean;
  winner?: string;
}

type Action =
  | { type: 'SCENE_OPEN'; scene: ActiveScene }
  | { type: 'UPDATE_DISPLAY'; text: string }
  | { type: 'SCENE_CLOSE'; closed: ClosedScene }
  | { type: 'GAME_OVER'; winner: string };

function reducer(state: SceneState, action: Action): SceneState {
  switch (action.type) {
    case 'SCENE_OPEN':
      return { ...state, activeScene: action.scene, displayText: '' };
    case 'UPDATE_DISPLAY':
      return { ...state, displayText: action.text };
    case 'SCENE_CLOSE':
      return {
        ...state,
        activeScene: null,
        displayText: '',
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
  displayText: '',
  gameOver: false,
};

export function useSceneEngine() {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const schedulerRef = useRef<RenderScheduler | null>(null);
  const activeSceneRef = useRef<ActiveScene | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCloseRef = useRef<ClosedScene | null>(null);
  const schedulerContentTypeRef = useRef<'thinking' | 'content'>('content');

  const flushPendingClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (pendingCloseRef.current) {
      schedulerRef.current?.destroy();
      schedulerRef.current = null;
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

        const scene: ActiveScene = {
          sceneId: msg.sceneId,
          sceneType: msg.sceneType,
          visibility: msg.visibility,
          actorId: msg.actorId,
        };
        activeSceneRef.current = scene;
        dispatch({ type: 'SCENE_OPEN', scene });

        schedulerRef.current = new RenderScheduler('content', (text) => {
          dispatch({ type: 'UPDATE_DISPLAY', text });
        });
        schedulerContentTypeRef.current = 'content';
      } else if (msg.type === 'scene.append') {
        const contentType = msg.contentType ?? 'content';
        if (contentType === 'thinking') {
          if (schedulerContentTypeRef.current !== 'thinking') {
            schedulerRef.current?.destroy();
            schedulerRef.current = new RenderScheduler('thinking', (text) => {
              dispatch({ type: 'UPDATE_DISPLAY', text });
            });
            schedulerContentTypeRef.current = 'thinking';
          }
          schedulerRef.current?.push(msg.token);
        } else {
          if (schedulerContentTypeRef.current !== 'content') {
            schedulerRef.current?.destroy();
            schedulerRef.current = new RenderScheduler('content', (text) => {
              dispatch({ type: 'UPDATE_DISPLAY', text });
            });
            schedulerContentTypeRef.current = 'content';
          }
          schedulerRef.current?.push(msg.token);
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
          fullContent: msg.fullContent,
          durationMs: msg.durationMs,
        };

        closeTimerRef.current = setTimeout(() => {
          schedulerRef.current?.destroy();
          schedulerRef.current = null;
          activeSceneRef.current = null;
          dispatch({ type: 'SCENE_CLOSE', closed });
        }, holdMs);
      } else if (msg.type === 'game.finished') {
        dispatch({ type: 'GAME_OVER', winner: msg.winner });
      }
    },
    [flushPendingClose],
  );

  return { state, handleMessage };
}
