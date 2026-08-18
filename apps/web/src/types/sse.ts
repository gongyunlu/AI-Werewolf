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
  fullContent: string;
  durationMs: number;
}

export interface GameFinishedEvent {
  type: 'game.finished';
  sequence: number;
  winner: string;
}

export type SseMessage =
  ConnectionReadyEvent | SceneOpenEvent | SceneAppendEvent | SceneCloseEvent | GameFinishedEvent;
