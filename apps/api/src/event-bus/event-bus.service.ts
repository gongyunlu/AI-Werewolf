import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Event } from '../generated/prisma/client';

/**
 * EventBus: 游戏事件的统一广播层
 *
 * 职责：接收已持久化的事件
 * 不负责持久化，只做消息分发
 */
@Injectable()
export class EventBusService {
  private readonly logger = new Logger(EventBusService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 发布事件
   *
   * @param event 已持久化的事件记录
   */
  async publish(event: Event): Promise<void> {
    this.logger.debug(
      `Event published: ${event.actionType} (seq=${event.sequence}, game=${event.gameId})`,
    );
    // SSE 广播功能已移除
  }
}
