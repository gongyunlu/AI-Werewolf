import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ACTION_TYPES, GAME_STATUSES } from '@ai-werewolf/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { Event, EventDeliveryOutbox } from '../generated/prisma/client';
import { SseBroadcasterService } from '../sse/sse-broadcaster.service';
import type { ConnectionReadyEvent, PlayerDeathSnapshot } from '../sse/sse-event.types';
import { projectEvent } from './event-projection';

export type PersistedGameSnapshot = Pick<
  ConnectionReadyEvent,
  'snapshot' | 'playerDeaths' | 'gameFinished' | 'gameStatus' | 'eventWatermark'
>;

type ClaimedDelivery = Pick<
  EventDeliveryOutbox,
  | 'deliveryKey'
  | 'gameId'
  | 'eventIds'
  | 'firstSequence'
  | 'lastSequence'
  | 'playerDeaths'
  | 'attempts'
  | 'leaseToken'
>;

/** 重试上限：到顶后不再领取，也不再阻塞同局后续交付，避免一条坏记录让整局的实时流永久停在原地。 */
const MAX_DELIVERY_ATTEMPTS = 10;

/** 提交后的独立交付；不依赖引擎执行权，也不具备再次行动的能力。 */
@Injectable()
export class EventBusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventBusService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<number>;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly sseBroadcaster?: SseBroadcasterService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => this.wake(), 1000);
    this.timer.unref();
    this.wake();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  /** 节点只唤醒消费者；崩溃或唤醒丢失由定时扫描补齐。 */
  async publish(_event: Event): Promise<void> {
    this.wake();
  }

  private wake() {
    if (this.stopped) return;
    void this.dispatchPending().catch((error: unknown) => {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        '交付扫描失败，等待重试',
      );
    });
  }

  dispatchPending(): Promise<number> {
    if (this.running) return this.running;
    this.running = this.dispatch().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async dispatch(): Promise<number> {
    const leaseToken = randomUUID();
    // 每局只领取最早未完成项；锁被其他消费者占用时，也不越过它领取后项。
    // 达到重试上限的记录视为已了结：既不领取，也不再挡住该局后续交付（内容仍可由重连快照补齐）。
    const deliveries = await this.prisma.$queryRaw<ClaimedDelivery[]>`
      WITH candidates AS (
        SELECT o.delivery_key FROM event_delivery_outbox o
        WHERE o.delivered_at IS NULL AND o.attempts < ${MAX_DELIVERY_ATTEMPTS}
          AND o.next_attempt_at <= now()
          AND (o.lease_until IS NULL OR o.lease_until <= now())
          AND NOT EXISTS (
            SELECT 1 FROM event_delivery_outbox earlier
            WHERE earlier.game_id = o.game_id AND earlier.delivered_at IS NULL
              AND earlier.attempts < ${MAX_DELIVERY_ATTEMPTS}
              AND earlier.first_sequence < o.first_sequence
          )
        ORDER BY o.next_attempt_at, o.created_at, o.delivery_key
        LIMIT 16 FOR UPDATE OF o SKIP LOCKED
      )
      UPDATE event_delivery_outbox o
      SET lease_token = ${leaseToken}::uuid, lease_until = now() + interval '30 seconds',
          attempts = o.attempts + 1
      FROM candidates c WHERE o.delivery_key = c.delivery_key
      RETURNING o.delivery_key AS "deliveryKey", o.game_id AS "gameId", o.event_ids AS "eventIds",
        o.first_sequence AS "firstSequence", o.last_sequence AS "lastSequence",
        o.player_deaths AS "playerDeaths", o.attempts, o.lease_token AS "leaseToken"
    `;
    if (!deliveries.length) return 0;
    const events = await this.prisma.event.findMany({
      where: { id: { in: deliveries.flatMap((item) => item.eventIds) } },
    });
    const byId = new Map(events.map((event) => [event.id, event]));
    await Promise.all(
      deliveries.map(async (delivery) => {
        try {
          const batch = delivery.eventIds.map((id) => byId.get(id));
          if (batch.some((event) => !event || event.gameId !== delivery.gameId))
            throw new Error('交付记录与已提交事件不一致');
          const committed = batch as Event[];
          const end = committed.find((event) => event.actionType === ACTION_TYPES.GAME_ENDED);
          const gameFinished = end
            ? { winner: (end.content as { winner: string }).winner }
            : undefined;
          if (!this.sseBroadcaster) throw new Error('交付广播层未装配');
          // 无订阅者由后来的数据库快照补齐；此返回值不代表浏览器确认。
          this.sseBroadcaster.emitCommitted(delivery.gameId, {
            type: 'events.committed',
            deliveryKey: delivery.deliveryKey,
            firstSequence: delivery.firstSequence,
            lastSequence: delivery.lastSequence,
            scenes: committed.flatMap((event) => {
              const scene = projectEvent(event);
              return scene ? [scene] : [];
            }),
            playerDeaths: delivery.playerDeaths as unknown as PlayerDeathSnapshot[],
            gameFinished,
          });
          const changed = await this.prisma.eventDeliveryOutbox.updateMany({
            where: { deliveryKey: delivery.deliveryKey, leaseToken, deliveredAt: null },
            data: { deliveredAt: new Date(), leaseToken: null, leaseUntil: null },
          });
          if (changed.count && gameFinished) this.sseBroadcaster.complete(delivery.gameId);
        } catch (error) {
          const abandoned = delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
          const delay = abandoned
            ? 0
            : Math.min(60_000, 1000 * 2 ** Math.min(delivery.attempts - 1, 6));
          const reason = error instanceof Error ? error.message : String(error);
          await this.prisma.eventDeliveryOutbox.updateMany({
            where: { deliveryKey: delivery.deliveryKey, leaseToken, deliveredAt: null },
            data: {
              nextAttemptAt: new Date(Date.now() + delay),
              leaseToken: null,
              leaseUntil: null,
            },
          });
          if (abandoned) {
            this.logger.error(
              {
                deliveryKey: delivery.deliveryKey,
                gameId: delivery.gameId,
                attempts: delivery.attempts,
                reason,
              },
              '已提交结果多次交付失败，放弃该批并继续后续交付',
            );
          } else {
            this.logger.warn(
              { deliveryKey: delivery.deliveryKey, attempts: delivery.attempts, reason },
              '已提交结果交付失败，稍后补送',
            );
          }
        }
      }),
    );
    return deliveries.length;
  }

  async assertExists(gameId: string): Promise<void> {
    const game = await this.prisma.game.findUnique({ where: { id: gameId }, select: { id: true } });
    if (!game) throw new NotFoundException('对局不存在');
  }

  async loadSnapshot(gameId: string): Promise<PersistedGameSnapshot> {
    return this.prisma.$transaction(
      async (tx) => {
        const [game, events, players] = await Promise.all([
          tx.game.findUnique({
            where: { id: gameId },
            select: { status: true, winnerFaction: true },
          }),
          tx.event.findMany({ where: { gameId }, orderBy: { sequence: 'asc' } }),
          tx.player.findMany({
            where: { gameId, deathDay: { not: null } },
            select: { id: true, deathDay: true, deathCause: true },
          }),
        ]);
        if (!game) throw new NotFoundException('对局不存在');
        const ended =
          game.status === GAME_STATUSES.FINISHED || game.status === GAME_STATUSES.ABORTED;
        return {
          snapshot: events.flatMap((event) => {
            const scene = projectEvent(event);
            return scene ? [scene] : [];
          }),
          eventWatermark: events.at(-1)?.sequence ?? 0,
          playerDeaths: players.flatMap((player) =>
            player.deathDay !== null && player.deathCause
              ? [{ playerId: player.id, deathDay: player.deathDay, deathCause: player.deathCause }]
              : [],
          ),
          gameStatus: game.status,
          gameFinished: ended
            ? {
                winner:
                  game.status === GAME_STATUSES.FINISHED
                    ? (game.winnerFaction ?? 'unknown')
                    : 'unknown',
              }
            : undefined,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async restore(gameId: string): Promise<void> {
    if (!this.sseBroadcaster) return;
    const [events, players] = await Promise.all([
      this.prisma.event.findMany({ where: { gameId }, orderBy: { sequence: 'asc' } }),
      this.prisma.player.findMany({ where: { gameId, deathDay: { not: null } } }),
    ]);
    this.sseBroadcaster.complete(gameId);
    this.sseBroadcaster.getOrCreate(gameId);
    this.sseBroadcaster.emitCommitted(gameId, {
      type: 'events.committed',
      deliveryKey: 'restore/' + gameId,
      firstSequence: events[0]?.sequence ?? 0,
      lastSequence: events.at(-1)?.sequence ?? 0,
      scenes: events.flatMap((event) => {
        const scene = projectEvent(event);
        return scene ? [scene] : [];
      }),
      playerDeaths: players.flatMap((player) =>
        player.deathDay !== null && player.deathCause
          ? [{ playerId: player.id, deathDay: player.deathDay, deathCause: player.deathCause }]
          : [],
      ),
    });
  }
}
