import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Subject, Observable } from 'rxjs';
import type {
  EventsCommittedEvent,
  GameFinishedSnapshot,
  PlayerDeathSnapshot,
  SceneSnapshot,
  SseMessage,
  SseSceneMessage,
  SseEmitPayload,
} from './sse-event.types';
import type { PersistedGameSnapshot } from '../event-bus/event-bus.service';

interface LiveGame {
  subject: Subject<SseMessage>;
  streamId: string;
  sequence: number;
  scenes: Map<string, SceneSnapshot>;
  committedScenes: Set<string>;
  deaths: Map<string, PlayerDeathSnapshot>;
  gameFinished?: GameFinishedSnapshot;
}

/** 完整历史由数据库提供；这里只保留活动文本和有界的近期场景，不保存每个 chunk。 */
@Injectable()
export class SseBroadcasterService {
  private readonly games = new Map<string, LiveGame>();

  getOrCreate(gameId: string): Subject<SseMessage> {
    let game = this.games.get(gameId);
    if (!game) {
      game = {
        subject: new Subject<SseMessage>(),
        streamId: randomUUID(),
        sequence: 0,
        scenes: new Map(),
        committedScenes: new Set(),
        deaths: new Map(),
      };
      this.games.set(gameId, game);
    }
    return game.subject;
  }

  /** 节点回调绑定当前流与取消信号，旧执行的迟到片段不能污染恢复后的流。 */
  forExecution(gameId: string, signal?: AbortSignal): Pick<SseBroadcasterService, 'emit'> {
    this.getOrCreate(gameId);
    const game = this.games.get(gameId)!;
    return {
      emit: (id, message) => {
        if (id !== gameId || signal?.aborted || this.games.get(gameId) !== game) return;
        this.emit(id, message);
      },
    };
  }

  emit(gameId: string, message: SseEmitPayload): void {
    const game = this.games.get(gameId);
    if (!game) return;
    const previewKey = 'sceneId' in message ? 'preview/' + message.sceneId : undefined;
    if ('sceneId' in message) {
      if (game.committedScenes.has(message.sceneId)) {
        if (message.type !== 'scene.close') return;
        const closed = message;
        const committed = [...game.scenes.values()].find(
          (scene) =>
            scene.eventId &&
            scene.sceneId === closed.sceneId &&
            scene.attemptId &&
            (!closed.attemptId || scene.attemptId === closed.attemptId),
        );
        if (!committed) return;
        committed.thinkingDurationMs = closed.thinkingDurationMs;
        committed.contentDurationMs = closed.contentDurationMs;
        game.subject.next({
          ...closed,
          eventId: committed.eventId,
          attemptId: committed.attemptId,
          streamId: game.streamId,
          sequence: ++game.sequence,
        });
        return;
      }
      const previous = game.scenes.get(previewKey!);
      if (message.type === 'scene.open') {
        // 同一尝试的重复 open 不清空已经收到的文本；新尝试才整体替换。
        if (message.attemptId && previous?.attemptId === message.attemptId) return;
        message = { ...message, attemptId: message.attemptId ?? randomUUID() };
        game.scenes.set(previewKey!, {
          sceneId: message.sceneId,
          attemptId: message.attemptId,
          sceneType: message.sceneType,
          visibility: message.visibility,
          actorId: message.actorId,
          thinking: '',
          content: message.initialContent ?? '',
          status: 'active',
          thinkingDurationMs: 0,
          contentDurationMs: 0,
          metadata: message.metadata,
        });
      } else {
        if (!previous || (message.attemptId && previous.attemptId !== message.attemptId)) return;
        message = { ...message, attemptId: previous.attemptId };
        if (message.type === 'scene.append') {
          if (previous.status !== 'active') return;
          previous[message.contentType] += message.token;
        } else if (message.type === 'scene.close') {
          if (previous.status === 'closed') return;
          previous.status = 'closed';
          previous.thinkingDurationMs = message.thinkingDurationMs;
          previous.contentDurationMs = message.contentDurationMs;
        }
      }
    } else if (message.type === 'events.committed') {
      const scenes: SceneSnapshot[] = [];
      for (const scene of message.scenes) {
        if (!scene.eventId) throw new Error('已提交场景缺少 Event ID');
        const previous = game.scenes.get('preview/' + scene.sceneId);
        const committed = game.scenes.get('event/' + scene.eventId);
        game.scenes.delete('preview/' + scene.sceneId);
        game.committedScenes.add(scene.sceneId);
        const finalized = {
          ...scene,
          attemptId: previous?.attemptId ?? committed?.attemptId,
          thinkingDurationMs:
            previous?.thinkingDurationMs ??
            committed?.thinkingDurationMs ??
            scene.thinkingDurationMs,
          contentDurationMs:
            previous?.contentDurationMs ?? committed?.contentDurationMs ?? scene.contentDurationMs,
        };
        game.scenes.set('event/' + scene.eventId, finalized);
        scenes.push(finalized);
      }
      message = { ...message, scenes };
      for (const death of message.playerDeaths) game.deaths.set(death.playerId, death);
      if (message.gameFinished) game.gameFinished = message.gameFinished;
    } else if (message.type === 'game.finished') {
      game.gameFinished = { winner: message.winner };
    }

    // 活动场景不受淘汰影响；已提交完整历史在重连时从数据库恢复。
    if (game.scenes.size > 1000) {
      for (const [key, scene] of game.scenes) {
        if (scene.status === 'closed') game.scenes.delete(key);
        if (game.scenes.size <= 1000) break;
      }
    }
    game.subject.next({
      ...message,
      streamId: game.streamId,
      sequence: ++game.sequence,
    } as SseSceneMessage);
  }

  emitCommitted(gameId: string, message: Omit<EventsCommittedEvent, 'sequence'>): void {
    this.emit(gameId, message);
  }

  exists(gameId: string): boolean {
    return this.games.has(gameId);
  }

  /** 先订阅并冻结内存进度，再异步读取数据库，期间消息按原序补齐。 */
  getRecoveryStream(
    gameId: string,
    loadSnapshot?: () => Promise<PersistedGameSnapshot>,
  ): Observable<SseMessage> {
    return new Observable<SseMessage>((subscriber) => {
      this.getOrCreate(gameId);
      const game = this.games.get(gameId)!;
      const pending: SseMessage[] = [];
      let readySent = false;
      let completed = false;
      let active = true;
      let releaseOnClose = false;
      const subscription = game.subject.subscribe({
        next: (message) => (readySent ? subscriber.next(message) : pending.push(message)),
        error: (error: unknown) => subscriber.error(error),
        complete: () => {
          completed = true;
          if (readySent) subscriber.complete();
        },
      });
      const sequence = game.sequence;
      const memory = structuredClone([...game.scenes.values()]);
      const memoryFinished = game.gameFinished;
      const sendReady = (persisted?: PersistedGameSnapshot) => {
        if (!active || subscriber.closed) return;
        // 执行代次切流后从新连接重新读，不能把旧进度拼入新尝试。
        if (this.games.has(gameId) && this.games.get(gameId) !== game) {
          subscriber.complete();
          return;
        }
        const committedAliases = new Set(persisted?.snapshot.map((scene) => scene.sceneId));
        releaseOnClose = !!persisted?.gameFinished;
        // 非活动状态的事实已在一致快照内；吸收缓冲水位，不能重放中断前的半句。
        const inactive =
          releaseOnClose ||
          persisted?.gameStatus === 'created' ||
          persisted?.gameStatus === 'pending_recovery';
        const lastSequence = inactive ? game.sequence : sequence;
        if (inactive) pending.length = 0;
        // 耗时没有落库，投影出来的已提交场景一律为 0，只有内存副本还留着真实值。
        const liveDurations = new Map(
          memory.flatMap((scene) => (scene.eventId ? [[scene.eventId, scene] as const] : [])),
        );
        const snapshot = persisted
          ? [
              ...persisted.snapshot.map((scene) => {
                const cached = scene.eventId ? liveDurations.get(scene.eventId) : undefined;
                return cached
                  ? {
                      ...scene,
                      thinkingDurationMs: cached.thinkingDurationMs,
                      contentDurationMs: cached.contentDurationMs,
                    }
                  : scene;
              }),
              ...memory.filter(
                (scene) =>
                  !persisted.gameFinished &&
                  persisted.gameStatus !== 'pending_recovery' &&
                  !scene.eventId &&
                  !committedAliases.has(scene.sceneId),
              ),
            ]
          : memory;
        subscriber.next({
          type: 'connection.ready',
          gameId,
          streamId: game.streamId,
          lastSequence,
          snapshot,
          eventWatermark: persisted?.eventWatermark,
          playerDeaths: persisted?.playerDeaths ?? [...game.deaths.values()],
          gameStatus: persisted?.gameStatus,
          gameFinished: persisted ? persisted.gameFinished : memoryFinished,
        });
        readySent = true;
        for (const message of pending) {
          if (!subscriber.closed) subscriber.next(message);
        }
        pending.length = 0;
        if (completed || persisted?.gameFinished || persisted?.gameStatus === 'created')
          subscriber.complete();
      };
      if (loadSnapshot) {
        void (async () => {
          let persisted = await loadSnapshot();
          // 取消可能在查询期间关闭流，且尚有未派发事实；再读一次完整终态。
          if (completed && active) persisted = await loadSnapshot();
          sendReady(persisted);
        })().catch((error: unknown) => {
          if (active) subscriber.error(error);
        });
      } else sendReady();
      return () => {
        active = false;
        subscription.unsubscribe();
        if (releaseOnClose && !game.subject.observed && this.games.get(gameId) === game)
          this.complete(gameId);
      };
    });
  }

  complete(gameId: string): void {
    const game = this.games.get(gameId);
    this.games.delete(gameId);
    game?.subject.complete();
  }
}
