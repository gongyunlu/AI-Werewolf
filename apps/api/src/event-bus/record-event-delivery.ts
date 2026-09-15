import type { Event, Prisma } from '../generated/prisma/client';
import type { PlayerDeathSnapshot } from '../sse/sse-event.types';
import { projectDeaths } from './event-projection';

/** 仅在首次领域提交的同一事务调用；业务复用不另造交付意图。 */
export async function recordEventDelivery(
  tx: Prisma.TransactionClient,
  events: Event[],
  batchKey?: string,
  playerDeaths: PlayerDeathSnapshot[] = [],
): Promise<void> {
  if (!events.length) return;
  await tx.eventDeliveryOutbox.create({
    data: {
      deliveryKey: batchKey ? 'batch/' + batchKey : 'event/' + events[0].id,
      gameId: events[0].gameId,
      batchKey,
      eventIds: events.map((event) => event.id),
      firstSequence: events[0].sequence,
      lastSequence: events.at(-1)!.sequence,
      playerDeaths: [
        ...events.flatMap(projectDeaths),
        ...playerDeaths,
      ] as unknown as Prisma.InputJsonValue,
    },
  });
}
