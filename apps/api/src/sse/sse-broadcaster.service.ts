import { Injectable } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import type { SseMessage, SseEmitPayload } from './sse-event.types';

@Injectable()
export class SseBroadcasterService {
  private readonly subjects = new Map<string, Subject<SseMessage>>();
  private readonly sequences = new Map<string, number>();

  /** 获取或创建游戏的 Subject，调用方负责 complete */
  getOrCreate(gameId: string): Subject<SseMessage> {
    if (!this.subjects.has(gameId)) {
      this.subjects.set(gameId, new Subject<SseMessage>());
      this.sequences.set(gameId, 0);
    }
    return this.subjects.get(gameId)!;
  }

  /** 推送事件，自动分配 sequence */
  emit(gameId: string, message: SseEmitPayload): void {
    const subject = this.subjects.get(gameId);
    if (!subject) return;
    const seq = this.sequences.get(gameId)! + 1;
    this.sequences.set(gameId, seq);
    subject.next({ ...message, sequence: seq } as SseMessage);
  }

  /** 检查游戏是否有活跃的广播流，控制器可用此方法做 404 前置校验 */
  exists(gameId: string): boolean {
    return this.subjects.has(gameId);
  }

  /**
   * SSE 控制器用于订阅。
   * 注意：调用时 gameId 应已存在（通过 exists() 校验），
   * 否则会隐式创建孤儿 Subject。
   */
  getStream(gameId: string): Observable<SseMessage> {
    return this.getOrCreate(gameId).asObservable();
  }

  /** 游戏结束后清理 */
  complete(gameId: string): void {
    this.subjects.get(gameId)?.complete();
    this.subjects.delete(gameId);
    this.sequences.delete(gameId);
  }
}
