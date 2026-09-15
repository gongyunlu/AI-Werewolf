export type SceneType =
  'system' | 'judge' | 'night_prompt' | 'speech' | 'vote' | 'night_action' | 'last_words';

export type SceneVisibility = 'public' | 'wolf' | 'seer' | 'witch' | 'god';

export interface SceneSnapshot {
  eventId?: string;
  eventSequence?: number;
  attemptId?: string;
  sceneId: string;
  sceneType: SceneType;
  visibility: SceneVisibility;
  actorId?: string;
  thinking: string;
  content: string;
  status: 'active' | 'closed';
  thinkingDurationMs: number;
  contentDurationMs: number;
  metadata?: Record<string, unknown>;
}

export interface PlayerDeathSnapshot {
  playerId: string;
  deathDay: number;
  deathCause: string;
}

export interface GameFinishedSnapshot {
  winner: string;
}

export interface ConnectionReadyEvent {
  type: 'connection.ready';
  gameId: string;
  lastSequence: number;
  streamId?: string;
  eventWatermark?: number;
  gameStatus?: string;
  snapshot: SceneSnapshot[];
  playerDeaths: PlayerDeathSnapshot[];
  gameFinished?: GameFinishedSnapshot;
}

export interface SceneOpenEvent {
  streamId?: string;
  attemptId?: string;
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
  streamId?: string;
  attemptId?: string;
  type: 'scene.append';
  sequence: number;
  sceneId: string;
  token: string;
  contentType: 'thinking' | 'content';
}

export interface SceneCloseEvent {
  /** 已提交场景的迟到关闭只更新显示耗时，不再追加正文。 */
  eventId?: string;
  streamId?: string;
  attemptId?: string;
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
  sequence?: number;
  winner: string;
}

/** 同一事务的最终结果一次合并；正文是完整投影，不能作为 delta 追加。 */
export interface EventsCommittedEvent {
  type: 'events.committed';
  sequence: number;
  streamId?: string;
  deliveryKey: string;
  firstSequence: number;
  lastSequence: number;
  scenes: SceneSnapshot[];
  playerDeaths: PlayerDeathSnapshot[];
  gameFinished?: GameFinishedSnapshot;
}

export type SseMessage =
  | EventsCommittedEvent
  | ConnectionReadyEvent
  | SceneOpenEvent
  | SceneAppendEvent
  | SceneCloseEvent
  | GameFinishedEvent;
