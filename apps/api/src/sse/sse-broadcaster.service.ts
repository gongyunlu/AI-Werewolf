import { Injectable } from '@nestjs/common';
import { Subject, Observable, concat, from } from 'rxjs';
import type { SseMessage, SseSceneMessage, SseEmitPayload } from './sse-event.types';

/** 每局重放缓冲上限，防止异常中断的对局让内存无限增长 */
const MAX_HISTORY_PER_GAME = 10000;

@Injectable()
export class SseBroadcasterService {
  private readonly subjects = new Map<string, Subject<SseMessage>>();
  private readonly sequences = new Map<string, number>();
  private readonly histories = new Map<string, SseSceneMessage[]>();

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
    const msg = { ...message, sequence: seq } as SseSceneMessage;
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

  /**
   * SSE 控制器用于订阅。
   * 先重放 lastSequence 之后的历史事件（断线重连/晚订阅场景），再订阅实时流。
   * 注意：调用时 gameId 应已存在（通过 exists() 校验），
   * 否则会隐式创建孤儿 Subject。
   */
  getStream(gameId: string, lastSequence = 0): Observable<SseMessage> {
    const history = this.histories.get(gameId) ?? [];
    const replay = history.filter((m) => m.sequence > lastSequence);
    return concat(from(replay), this.getOrCreate(gameId).asObservable());
  }

  /** 游戏结束后清理 */
  complete(gameId: string): void {
    this.subjects.get(gameId)?.complete();
    this.subjects.delete(gameId);
    this.sequences.delete(gameId);
    this.histories.delete(gameId);
  }
}
