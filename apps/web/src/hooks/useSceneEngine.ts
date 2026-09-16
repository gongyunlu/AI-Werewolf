import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { SceneSnapshot, SseMessage } from '@/types/sse';

export type ClosedScene = Omit<SceneSnapshot, 'status'>;
export type ActiveScene = Omit<ClosedScene, 'thinkingDurationMs' | 'contentDurationMs'>;

export interface SceneState {
  closedScenes: ClosedScene[];
  activeScene: ActiveScene | null;
  gameOver: boolean;
  winner?: string;
}

type Action =
  | { type: 'HYDRATE'; state: SceneState }
  | { type: 'SCENE_OPEN'; scene: ActiveScene }
  | {
      type: 'APPEND';
      sceneId: string;
      attemptId?: string;
      token: string;
      contentType: 'thinking' | 'content';
    }
  | { type: 'SCENE_CLOSE'; closed: ClosedScene }
  | { type: 'SCENE_TIMING'; eventId: string; thinkingDurationMs: number; contentDurationMs: number }
  | { type: 'COMMITTED'; scenes: ClosedScene[]; winner?: string }
  | { type: 'GAME_OVER'; winner: string };

export function sceneReducer(state: SceneState, action: Action): SceneState {
  switch (action.type) {
    case 'HYDRATE':
      return action.state;
    case 'SCENE_OPEN': {
      if (
        state.gameOver ||
        state.closedScenes.some((scene) => scene.eventId && scene.sceneId === action.scene.sceneId)
      )
        return state;
      if (action.scene.attemptId && state.activeScene?.attemptId === action.scene.attemptId)
        return state;
      return {
        ...state,
        activeScene: action.scene,
        closedScenes: state.closedScenes.filter(
          (scene) => scene.eventId || scene.sceneId !== action.scene.sceneId,
        ),
      };
    }
    case 'APPEND': {
      const active = state.activeScene;
      if (
        !active ||
        active.sceneId !== action.sceneId ||
        (action.attemptId && active.attemptId !== action.attemptId)
      )
        return state;
      return {
        ...state,
        activeScene: { ...active, [action.contentType]: active[action.contentType] + action.token },
      };
    }
    case 'SCENE_CLOSE': {
      if (
        state.closedScenes.some(
          (scene) =>
            scene.sceneId === action.closed.sceneId &&
            (scene.eventId || scene.attemptId === action.closed.attemptId),
        )
      )
        return state;
      return {
        ...state,
        activeScene:
          state.activeScene?.sceneId === action.closed.sceneId ? null : state.activeScene,
        closedScenes: [...state.closedScenes, action.closed],
      };
    }
    case 'COMMITTED': {
      const ids = new Set(action.scenes.map((scene) => scene.eventId));
      const aliases = new Set(action.scenes.map((scene) => scene.sceneId));
      const previous = new Map(state.closedScenes.map((scene) => [scene.sceneId, scene]));
      const scenes = action.scenes.map((scene) => {
        const preview = previous.get(scene.sceneId);
        return {
          ...scene,
          thinkingDurationMs: preview?.thinkingDurationMs ?? scene.thinkingDurationMs,
          contentDurationMs: preview?.contentDurationMs ?? scene.contentDurationMs,
        };
      });
      const closedScenes = [
        ...state.closedScenes.filter((scene) =>
          scene.eventId ? !ids.has(scene.eventId) : !aliases.has(scene.sceneId),
        ),
        ...scenes,
      ].toSorted((a, b) => (a.eventSequence ?? Infinity) - (b.eventSequence ?? Infinity));
      return {
        ...state,
        closedScenes,
        activeScene:
          action.winner !== undefined ||
          (state.activeScene && aliases.has(state.activeScene.sceneId))
            ? null
            : state.activeScene,
        gameOver: state.gameOver || action.winner !== undefined,
        winner: action.winner ?? state.winner,
      };
    }
    case 'SCENE_TIMING':
      return {
        ...state,
        closedScenes: state.closedScenes.map((scene) =>
          scene.eventId === action.eventId
            ? {
                ...scene,
                thinkingDurationMs: action.thinkingDurationMs,
                contentDurationMs: action.contentDurationMs,
              }
            : scene,
        ),
      };
    case 'GAME_OVER':
      return { ...state, activeScene: null, gameOver: true, winner: action.winner };
    default:
      return state;
  }
}

const INITIAL_STATE: SceneState = { closedScenes: [], activeScene: null, gameOver: false };
/** 保留既有预览场景的最小停留时长；最终批次按一次消息整体合并。 */
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
  const [state, dispatch] = useReducer(sceneReducer, INITIAL_STATE);
  const activeSceneRef = useRef<ActiveScene | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCloseRef = useRef<ClosedScene | null>(null);
  const committedAliasesRef = useRef(new Set<string>());
  const streamIdRef = useRef<string | undefined>(undefined);

  const cancelCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);
  useEffect(() => cancelCloseTimer, [cancelCloseTimer]);

  const flushPendingClose = useCallback(() => {
    cancelCloseTimer();
    if (pendingCloseRef.current) {
      if (activeSceneRef.current?.sceneId === pendingCloseRef.current.sceneId)
        activeSceneRef.current = null;
      dispatch({ type: 'SCENE_CLOSE', closed: pendingCloseRef.current });
      pendingCloseRef.current = null;
    }
  }, [cancelCloseTimer]);

  const handleMessage = useCallback(
    (msg: SseMessage) => {
      if (msg.type === 'connection.ready') {
        cancelCloseTimer();
        pendingCloseRef.current = null;
        streamIdRef.current = msg.streamId;
        committedAliasesRef.current = new Set(
          msg.snapshot.filter((scene) => scene.eventId).map((scene) => scene.sceneId),
        );
        const visible = msg.snapshot.filter(
          (scene) => perspective !== 'villager' || scene.visibility === 'public',
        );
        const closedScenes = visible.filter((scene) => scene.status === 'closed').map(toClosed);
        const active = visible.findLast((scene) => scene.status === 'active');
        activeSceneRef.current = active ? toClosed(active) : null;
        dispatch({
          type: 'HYDRATE',
          state: {
            closedScenes,
            activeScene: activeSceneRef.current,
            gameOver: !!msg.gameFinished,
            winner: msg.gameFinished?.winner,
          },
        });
        return;
      }
      if (
        'streamId' in msg &&
        msg.streamId &&
        streamIdRef.current &&
        msg.streamId !== streamIdRef.current
      )
        return;
      if (msg.type === 'events.committed') {
        for (const scene of msg.scenes) committedAliasesRef.current.add(scene.sceneId);
        const aliases = new Set(msg.scenes.map((scene) => scene.sceneId));
        if (
          msg.gameFinished ||
          (pendingCloseRef.current && aliases.has(pendingCloseRef.current.sceneId))
        ) {
          cancelCloseTimer();
          pendingCloseRef.current = null;
        }
        if (
          msg.gameFinished ||
          (activeSceneRef.current && aliases.has(activeSceneRef.current.sceneId))
        )
          activeSceneRef.current = null;
        dispatch({
          type: 'COMMITTED',
          scenes: msg.scenes
            .filter((scene) => perspective !== 'villager' || scene.visibility === 'public')
            .map(toClosed),
          winner: msg.gameFinished?.winner,
        });
      } else if (msg.type === 'scene.open') {
        if (committedAliasesRef.current.has(msg.sceneId)) return;
        if (msg.attemptId && activeSceneRef.current?.attemptId === msg.attemptId) return;
        flushPendingClose();
        if (perspective === 'villager' && msg.visibility !== 'public') return;
        const scene: ActiveScene = {
          sceneId: msg.sceneId,
          attemptId: msg.attemptId,
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
        const active = activeSceneRef.current;
        if (
          !active ||
          active.sceneId !== msg.sceneId ||
          (msg.attemptId && active.attemptId !== msg.attemptId)
        )
          return;
        activeSceneRef.current = {
          ...active,
          [msg.contentType]: active[msg.contentType] + msg.token,
        };
        dispatch({
          type: 'APPEND',
          sceneId: msg.sceneId,
          attemptId: msg.attemptId,
          token: msg.token,
          contentType: msg.contentType,
        });
      } else if (msg.type === 'scene.close') {
        if (msg.eventId) {
          dispatch({
            type: 'SCENE_TIMING',
            eventId: msg.eventId,
            thinkingDurationMs: msg.thinkingDurationMs,
            contentDurationMs: msg.contentDurationMs,
          });
          return;
        }
        const scene = activeSceneRef.current;
        if (
          !scene ||
          scene.sceneId !== msg.sceneId ||
          (msg.attemptId && scene.attemptId !== msg.attemptId)
        )
          return;
        if (pendingCloseRef.current?.sceneId === msg.sceneId) return;
        const closed: ClosedScene = {
          ...scene,
          thinkingDurationMs: msg.thinkingDurationMs,
          contentDurationMs: msg.contentDurationMs,
        };
        pendingCloseRef.current = closed;
        closeTimerRef.current = setTimeout(flushPendingClose, HOLD_UNTIL_MS[scene.sceneType] ?? 0);
      } else if (msg.type === 'game.finished') {
        // 终态只保留已完成的历史，未提交预览不能被延迟关闭定时器变成最终卡片。
        cancelCloseTimer();
        pendingCloseRef.current = null;
        activeSceneRef.current = null;
        dispatch({ type: 'GAME_OVER', winner: msg.winner });
      }
    },
    [cancelCloseTimer, flushPendingClose, perspective],
  );

  return { state, handleMessage };
}

function toClosed(snapshot: SceneSnapshot): ClosedScene {
  const { status: _status, ...scene } = snapshot;
  return scene;
}
