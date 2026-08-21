export type SceneType =
  'system' | 'judge' | 'night_prompt' | 'speech' | 'vote' | 'night_action' | 'last_words';

export type SceneVisibility = 'public' | 'wolf' | 'seer' | 'witch' | 'god';

export interface SceneSnapshot {
  sceneId: string;
  sceneType: SceneType;
  visibility: SceneVisibility;
  actorId?: string;
  fullContent: string;
  metadata?: Record<string, unknown>;
}

export interface ConnectionReadyEvent {
  type: 'connection.ready';
  gameId: string;
  lastSequence: number;
  snapshot: SceneSnapshot[];
}

export interface SceneOpenEvent {
  type: 'scene.open';
  sequence: number;
  sceneId: string;
  sceneType: SceneType;
  visibility: SceneVisibility;
  actorId?: string;
  /** 非流式场景的完整正文（法官播报/系统通知等），内联展示，无需走 scene.append */
  initialContent?: string;
  metadata?: Record<string, unknown>;
}

export interface SceneAppendEvent {
  type: 'scene.append';
  sequence: number;
  sceneId: string;
  token: string;
  contentType: 'thinking' | 'content';
}

export interface SceneCloseEvent {
  type: 'scene.close';
  sequence: number;
  sceneId: string;
  /** 思考阶段耗时（ms），无思考阶段的场景为 0 */
  thinkingDurationMs: number;
  /** 正文阶段耗时（ms），非流式场景为 0 */
  contentDurationMs: number;
}

export interface GameFinishedEvent {
  type: 'game.finished';
  sequence: number;
  winner: string;
}

export interface PlayerDiedEvent {
  type: 'player.died';
  sequence: number;
  playerId: string;
  deathDay: number;
  deathCause: string;
}

export type SseMessage =
  | ConnectionReadyEvent
  | SceneOpenEvent
  | SceneAppendEvent
  | SceneCloseEvent
  | GameFinishedEvent
  | PlayerDiedEvent;
