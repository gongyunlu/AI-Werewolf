import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Event, Prisma } from '../generated/prisma/client';

/**
 * EventBus: 游戏事件的统一写入和广播层
 *
 * TODO: broadcast() 钩子先空实现，后续接入 Redis
 */
@Injectable()
export class EventBusService {
  private readonly logger = new Logger(EventBusService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 事件写入数据库，并广播给订阅者
   *
   * @param data 事件数据
   * @returns 创建的事件记录
   */
  async emit(data: Prisma.EventCreateInput): Promise<Event> {
    // 1. 写入数据库
    const event = await this.prisma.event.create({ data });

    this.logger.debug(
      `Event emitted: ${event.actionType} (seq=${event.sequence}, game=${event.gameId})`,
    );

    // 2. 广播事件
    await this.broadcast(event);

    return event;
  }

  /**
   * 广播事件到订阅者
   *
   * TODO：通过 Redis Pub/Sub 推送给 SSE 订阅者
   *
   * @param event 要广播的事件
   */
  private async broadcast(event: Event): Promise<void> {
    // TODO: 接入 Redis Pub/Sub
    this.logger.debug(`[TODO] Broadcast event ${event.id} to subscribers`);
  }
}
