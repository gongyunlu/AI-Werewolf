import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Event } from '../generated/prisma/client';
import { BroadcasterService } from '../broadcaster/broadcaster.service';

/**
 * EventBus: 游戏事件的统一广播层
 *
 * 职责：接收已持久化的事件，广播给 SSE 订阅者
 * 不负责持久化，只做消息分发
 */
@Injectable()
export class EventBusService {
  private readonly logger = new Logger(EventBusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcaster: BroadcasterService,
  ) {}

  /**
   * 发布事件到 SSE 订阅者
   *
   * @param event 已持久化的事件记录
   */
  async publish(event: Event): Promise<void> {
    this.logger.debug(
      `Event published: ${event.actionType} (seq=${event.sequence}, game=${event.gameId})`,
    );

    // 广播事件到 SSE 订阅者
    void this.broadcaster.broadcastGameEvent(event);
  }
}
