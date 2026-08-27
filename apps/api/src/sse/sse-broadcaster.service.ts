import { Injectable } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import type {
  ConnectionReadyEvent,
  GameFinishedSnapshot,
  PlayerDeathSnapshot,
  SceneSnapshot,
  SseMessage,
  SseSceneMessage,
  SseEmitPayload,
} from './sse-event.types';

/** 每局重放缓冲上限，防止异常中断的对局让内存无限增长 */
const MAX_HISTORY_PER_GAME = 10000;
type SequencedSseMessage = SseSceneMessage & { sequence: number };

@Injectable()
export class SseBroadcasterService {
  private readonly subjects = new Map<string, Subject<SseMessage>>();
  private readonly sequences = new Map<string, number>();
  private readonly histories = new Map<string, SequencedSseMessage[]>();

  /** 获取或创建游戏的 Subject，调用方负责 complete */
  getOrCreate(gameId: string): Subject<SseMessage> {
    if (!this.subjects.has(gameId)) {
      this.subjects.set(gameId, new Subject<SseMessage>());
      this.sequences.set(gameId, 0);
      this.histories.set(gameId, []);
    }
    return this.subjects.get(gameId)!;
  }

  /** 推送事件，自动分配 sequence 并写入重放缓冲 */
  emit(gameId: string, message: SseEmitPayload): void {
    const subject = this.subjects.get(gameId);
    if (!subject) return;
    const seq = this.sequences.get(gameId)! + 1;
    this.sequences.set(gameId, seq);
    const msg = { ...message, sequence: seq } as SequencedSseMessage;
    const history = this.histories.get(gameId);
    if (history) {
      history.push(msg);
      if (history.length > MAX_HISTORY_PER_GAME) {
        history.splice(0, history.length - MAX_HISTORY_PER_GAME);
      }
    }
    subject.next(msg);
  }

  /** 检查游戏是否有活跃的广播流，控制器可用此方法做 404 前置校验 */
  exists(gameId: string): boolean {
    return this.subjects.has(gameId);
  }

  /** 建立无漏帧的恢复快照 + 实时流。 */
  getRecoveryStream(gameId: string): Observable<SseMessage> {
    return new Observable<SseMessage>((subscriber) => {
      const subject = this.subjects.get(gameId);
      if (!subject) {
        subscriber.complete();
        return undefined;
      }

      const pending: SequencedSseMessage[] = [];
      let readySent = false;
      let completedBeforeReady = false;
      let errorBeforeReady: unknown;

      const liveSubscription = subject.subscribe({
        next: (message) => {
          if (readySent) subscriber.next(message);
          else pending.push(message as SequencedSseMessage);
        },
        error: (error: unknown) => {
          if (readySent) subscriber.error(error);
          else errorBeforeReady = error;
        },
        complete: () => {
          if (readySent) subscriber.complete();
          else completedBeforeReady = true;
        },
      });

      const watermark = this.sequences.get(gameId) ?? 0;
      const history = (this.histories.get(gameId) ?? []).filter(
        (message) => message.sequence <= watermark,
      );
      subscriber.next(this.buildReadyEvent(gameId, watermark, history));
      readySent = true;

      for (const message of pending) {
        if (message.sequence > watermark) subscriber.next(message);
      }

      if (errorBeforeReady) subscriber.error(errorBeforeReady);
      else if (completedBeforeReady) subscriber.complete();

      return () => liveSubscription.unsubscribe();
    });
  }

  private buildReadyEvent(
    gameId: string,
    lastSequence: number,
    history: SequencedSseMessage[],
  ): ConnectionReadyEvent {
    const scenes: SceneSnapshot[] = [];
    const scenesById = new Map<string, SceneSnapshot>();
    const deathsByPlayer = new Map<string, PlayerDeathSnapshot>();
    let gameFinished: GameFinishedSnapshot | undefined;

    for (const message of history) {
      switch (message.type) {
        case 'scene.open': {
          const scene: SceneSnapshot = {
            sceneId: message.sceneId,
            sceneType: message.sceneType,
            visibility: message.visibility,
            actorId: message.actorId,
            thinking: '',
            content: message.initialContent ?? '',
            status: 'active',
            thinkingDurationMs: 0,
            contentDurationMs: 0,
            metadata: message.metadata,
          };
          scenes.push(scene);
          scenesById.set(scene.sceneId, scene);
          break;
        }
        case 'scene.append': {
          const scene = scenesById.get(message.sceneId);
          if (!scene) break;
          if (message.contentType === 'thinking') scene.thinking += message.token;
          else scene.content += message.token;
          break;
        }
        case 'scene.close': {
          const scene = scenesById.get(message.sceneId);
          if (!scene) break;
          scene.status = 'closed';
          scene.thinkingDurationMs = message.thinkingDurationMs;
          scene.contentDurationMs = message.contentDurationMs;
          break;
        }
        case 'player.died':
          deathsByPlayer.set(message.playerId, {
            playerId: message.playerId,
            deathDay: message.deathDay,
            deathCause: message.deathCause,
          });
          break;
        case 'game.finished':
          gameFinished = { winner: message.winner };
          break;
      }
    }

    return {
      type: 'connection.ready',
      gameId,
      lastSequence,
      snapshot: scenes,
      playerDeaths: [...deathsByPlayer.values()],
      gameFinished,
    };
  }

  /** 游戏结束后清理 */
  complete(gameId: string): void {
    this.subjects.get(gameId)?.complete();
    this.subjects.delete(gameId);
    this.sequences.delete(gameId);
    this.histories.delete(gameId);
  }
}
