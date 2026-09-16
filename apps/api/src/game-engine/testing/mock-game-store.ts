import type { Event } from '@/generated/prisma/client';
import { Standard6pPreset } from '../presets/game-presets';

type Query = { where?: Record<string, unknown>; orderBy?: Record<string, 'asc' | 'desc'> };

function matches(row: object, where: Query['where'] = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR' && Array.isArray(expected))
      return expected.some((condition) => matches(row, condition));
    const actual = (row as Record<string, unknown>)[key];
    if (expected !== null && typeof expected === 'object') {
      const filter = expected as Record<string, unknown>;
      return Object.entries(filter).every(([operator, value]) => {
        if (operator === 'in' && Array.isArray(value)) return value.includes(actual);
        if (operator === 'not') return actual !== value;
        if (operator === 'lte') return Number(actual) <= Number(value);
        throw new Error(`Mock store 不支持查询条件 ${key}.${operator}`);
      });
    }
    return actual === expected;
  });
}

function selectRows<T extends object>(rows: T[], query: Query = {}): T[] {
  const selected = rows.filter((row) => matches(row, query.where));
  for (const [key, direction] of Object.entries(query.orderBy ?? {})) {
    selected.sort((a, b) => {
      const left = (a as Record<string, unknown>)[key] as number;
      const right = (b as Record<string, unknown>)[key] as number;
      return (left < right ? -1 : left > right ? 1 : 0) * (direction === 'asc' ? 1 : -1);
    });
  }
  return structuredClone(selected);
}

/** 外部存储的内存替身；不提供数据库锁、事务隔离或跨进程保证。 */
export class MockGameStore {
  readonly gameId = '00000000-0000-4000-8000-000000000001';
  readonly game = {
    id: this.gameId,
    status: 'running',
    rulesetId: 'standard6p',
    skillVersion: 'v1',
    experiment: null,
    execution: null,
    winnerFaction: null as string | null,
    totalDays: 0,
    endedAt: null as Date | null,
  };
  readonly ruleset = {
    id: 'standard6p',
    definition: { speechRules: { useTimeRule: false, useDeathPosition: true } },
  };
  readonly players = Standard6pPreset.roles!.map((role, index) => ({
    id: `player-${index + 1}`,
    agentId: `agent-${index + 1}`,
    gameId: this.gameId,
    role,
    faction: role === 'werewolf' ? 'werewolf' : 'villager',
    seatNo: index + 1,
    modelName: `mock-seat-${index + 1}`,
    displayName: `玩家${index + 1}`,
    deathDay: null as number | null,
    deathCause: null as string | null,
    isSheriff: false,
    memoryLabelSnapshot: 'default',
  }));
  readonly events: Event[] = [];
  readonly snapshots = new Map<string, unknown>();
  readonly batches = new Map<
    string,
    { batchKey: string; gameId: string; payloadHash: string; outcomes: unknown; eventIds: string[] }
  >();
  readonly counters = new Map<string, number>();
  readonly deliveries = new Map<string, Record<string, unknown>>();
  afterEventCreated?: (event: Event) => void;
  afterTransactionCommitted?: (events: Event[]) => void;
  private transactionTail: Promise<void> = Promise.resolve();

  readonly prisma = {
    eventDeliveryOutbox: {
      create: jest.fn(
        async ({ data }: { data: { deliveryKey: string } & Record<string, unknown> }) => {
          if (this.deliveries.has(data.deliveryKey)) throw new Error('重复交付意图');
          this.deliveries.set(data.deliveryKey, structuredClone(data));
          return structuredClone(data);
        },
      ),
    },
    $queryRaw: jest.fn(async () => [{ status: this.game.status }]),
    effectBatchCommit: {
      findUnique: jest.fn(async ({ where }: { where: { batchKey: string } }) =>
        structuredClone(this.batches.get(where.batchKey) ?? null),
      ),
      create: jest.fn(
        async ({
          data,
        }: {
          data: {
            batchKey: string;
            gameId: string;
            payloadHash: string;
            outcomes: unknown;
            eventIds: string[];
          };
        }) => {
          if (this.batches.has(data.batchKey))
            throw Object.assign(new Error('重复批次'), { code: 'P2002' });
          this.batches.set(data.batchKey, structuredClone(data));
          return structuredClone(data);
        },
      ),
    },
    game: {
      findUniqueOrThrow: jest.fn(async () => structuredClone(this.game)),
      findUnique: jest.fn(async ({ where }: Query) =>
        matches(this.game, where)
          ? structuredClone({ ...this.game, players: this.players, ruleset: this.ruleset })
          : null,
      ),
      update: jest.fn(async ({ where, data }: Query & { data: object }) => {
        if (!matches(this.game, where)) throw new Error('Mock game missing');
        Object.assign(this.game, data);
        return structuredClone(this.game);
      }),
      updateMany: jest.fn(async ({ where, data }: Query & { data: object }) => {
        if (!matches(this.game, where)) return { count: 0 };
        Object.assign(this.game, data);
        return { count: 1 };
      }),
    },
    player: {
      findUnique: jest.fn(async ({ where }: Query) => {
        const player = this.players.find((row) => matches(row, where));
        return player ? structuredClone({ ...player, game: this.game }) : null;
      }),
      findMany: jest.fn(async (query: Query) => selectRows(this.players, query)),
      update: jest.fn(async ({ where, data }: Query & { data: object }) => {
        const player = this.players.find((row) => matches(row, where));
        if (!player) throw new Error('Mock player missing');
        Object.assign(player, data);
        return structuredClone(player);
      }),
    },
    event: {
      findUnique: jest.fn(async (query: Query) => selectRows(this.events, query)[0] ?? null),
      count: jest.fn(async (query: Query) => selectRows(this.events, query).length),
      findMany: jest.fn(async (query: Query) => selectRows(this.events, query)),
      findFirst: jest.fn(async (query: Query) => selectRows(this.events, query)[0] ?? null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (
          this.events.some(
            (event) =>
              (event.gameId === data.gameId && event.sequence === data.sequence) ||
              (data.effectKey && event.effectKey === data.effectKey),
          )
        )
          throw Object.assign(new Error('duplicate sequence'), { code: 'P2002' });
        const event = {
          effectKey: null,
          payloadHash: null,
          ...JSON.parse(JSON.stringify(data)),
          id: `event-${data.sequence}`,
          createdAt: new Date(),
        } as Event;
        this.events.push(event);
        this.afterEventCreated?.(event);
        return structuredClone(event);
      }),
    },
    ruleset: { findUnique: jest.fn(async () => structuredClone(this.ruleset)) },
    decisionContext: {
      createMany: jest.fn(async ({ data }: { data: Array<{ eventId: string }> }) => {
        for (const row of data) this.snapshots.set(row.eventId, structuredClone(row));
        return { count: data.length };
      }),
      findMany: jest.fn(async (query: Query) =>
        selectRows([...this.snapshots.values()] as Array<Record<string, unknown>>, query),
      ),
      upsert: jest.fn(
        async ({ where, create }: { where: { eventId: string }; create: unknown }) => {
          if (!this.snapshots.has(where.eventId))
            this.snapshots.set(where.eventId, structuredClone(create));
          return this.snapshots.get(where.eventId);
        },
      ),
    },
    memoryUsage: { createMany: jest.fn(async () => ({ count: 0 })) },
    $transaction: async <T>(action: (tx: MockGameStore['prisma']) => Promise<T>): Promise<T> => {
      const previous = this.transactionTail;
      let release!: () => void;
      this.transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const before = structuredClone({
        game: this.game,
        events: this.events,
        players: this.players,
        batches: this.batches,
        deliveries: this.deliveries,
      });
      let result: T;
      try {
        result = await action(this.prisma);
      } catch (error) {
        Object.assign(this.game, before.game);
        this.events.splice(0, this.events.length, ...before.events);
        this.players.splice(0, this.players.length, ...before.players);
        this.batches.clear();
        for (const [key, value] of before.batches) this.batches.set(key, value);
        this.deliveries.clear();
        for (const [key, value] of before.deliveries) this.deliveries.set(key, value);
        throw error;
      } finally {
        release();
      }
      this.afterTransactionCommitted?.(this.events.slice(before.events.length));
      return result;
    },
  };

  private readonly promptValues = new Map<string, string>();
  readonly redis = {
    get: jest.fn(async (key: string) => this.promptValues.get(key) ?? null),
    incr: jest.fn(async (key: string) => {
      const next = (this.counters.get(key) ?? 0) + 1;
      this.counters.set(key, next);
      return next;
    }),
    incrby: jest.fn(async (key: string, amount: number) => {
      const next = (this.counters.get(key) ?? 0) + amount;
      this.counters.set(key, next);
      return next;
    }),
    set: jest.fn(async (key: string, value: number | string, mode?: string) => {
      if (typeof value === 'string') {
        if (mode === 'NX' && this.promptValues.has(key)) return null;
        this.promptValues.set(key, value);
        return 'OK';
      }
      if (mode === 'NX' && this.counters.has(key)) return null;
      this.counters.set(key, value);
      return 'OK';
    }),
    exists: jest.fn(async (key: string) => Number(this.counters.has(key))),
  };
}
