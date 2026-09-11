import { Inject, Injectable, OnModuleDestroy, OnModuleInit, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type BaseMessage,
  type StoredMessage,
} from '@langchain/core/messages';
import { Pool } from 'pg';
import type { Env } from '../config/env.validation';
import type { Prisma } from '../generated/prisma/client';

const CHAT_HISTORY_TABLE = 'langchain.langchain_chat_histories';
const QUOTED_CHAT_HISTORY_TABLE = '"langchain"."langchain_chat_histories"';

export const CHAT_HISTORY_POOL = Symbol('CHAT_HISTORY_POOL');

export const chatHistoryPoolProvider: Provider = {
  provide: CHAT_HISTORY_POOL,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new Pool({ connectionString: config.get('DATABASE_URL', { infer: true }) }),
};

type StoredMessageJson = Record<string, unknown> & { type: string };

/**
 * 会话历史仓储。表结构由 Prisma migration 管理，运行时只执行 DML。
 */
@Injectable()
export class ChatHistoryService implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(CHAT_HISTORY_POOL) private readonly pool: Pool) {}

  async onModuleInit(): Promise<void> {
    const result = await this.pool.query<{ tableName: string | null }>(
      'SELECT to_regclass($1) AS "tableName"',
      [CHAT_HISTORY_TABLE],
    );
    if (!result.rows[0]?.tableName) {
      throw new Error(`缺少会话历史表 ${CHAT_HISTORY_TABLE}，请先执行 Prisma migration`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async load(sessionId: string): Promise<BaseMessage[]> {
    const result = await this.pool.query<{ message: StoredMessageJson }>(
      `SELECT "message" FROM ${QUOTED_CHAT_HISTORY_TABLE} WHERE "session_id" = $1 ORDER BY "id"`,
      [sessionId],
    );
    const storedMessages = result.rows.map(({ message }) => {
      if (
        !message ||
        typeof message !== 'object' ||
        typeof message.type !== 'string' ||
        !Object.hasOwn(message, 'content')
      ) {
        throw new Error(`会话 ${sessionId} 包含格式无效的历史消息`);
      }
      const { type, ...data } = message;
      return { type, data: data as unknown as StoredMessage['data'] };
    });
    return mapStoredMessagesToChatMessages(storedMessages);
  }

  /** 原子替换单个会话的滑动窗口，避免 clear 后写入一半。 */
  async replace(
    sessionId: string,
    messages: BaseMessage[],
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const storedMessages = mapChatMessagesToStoredMessages(messages).map(({ data, type }) =>
      Object.assign({}, data, { type }),
    );
    if (tx) {
      await tx.$executeRaw`DELETE FROM "langchain"."langchain_chat_histories" WHERE "session_id" = ${sessionId}`;
      for (const message of storedMessages) {
        await tx.$executeRaw`INSERT INTO "langchain"."langchain_chat_histories" ("session_id", "message") VALUES (${sessionId}, ${JSON.stringify(message)}::jsonb)`;
      }
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM ${QUOTED_CHAT_HISTORY_TABLE} WHERE "session_id" = $1`, [
        sessionId,
      ]);
      for (const message of storedMessages) {
        await client.query(
          `INSERT INTO ${QUOTED_CHAT_HISTORY_TABLE} ("session_id", "message") VALUES ($1, $2)`,
          [sessionId, message],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
