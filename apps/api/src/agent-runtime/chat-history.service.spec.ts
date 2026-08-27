import { HumanMessage, mapChatMessagesToStoredMessages } from '@langchain/core/messages';
import type { Pool, PoolClient } from 'pg';
import { ChatHistoryService } from './chat-history.service';

function createPool() {
  const client = {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  } as unknown as PoolClient;
  const pool = {
    query: jest.fn(),
    connect: jest.fn().mockResolvedValue(client),
    end: jest.fn().mockResolvedValue(undefined),
  } as unknown as Pool;
  return { pool, client };
}

describe('ChatHistoryService', () => {
  it('启动时要求迁移已经创建历史表', async () => {
    const { pool } = createPool();
    (pool.query as jest.Mock).mockResolvedValue({ rows: [{ tableName: null }] });
    const service = new ChatHistoryService(pool);

    await expect(service.onModuleInit()).rejects.toThrow('请先执行 Prisma migration');
  });

  it('从现有 JSONB 记录恢复 LangChain 消息', async () => {
    const { pool } = createPool();
    const stored = mapChatMessagesToStoredMessages([new HumanMessage('你好')])[0];
    (pool.query as jest.Mock).mockResolvedValue({
      rows: [{ message: { ...stored.data, type: stored.type } }],
    });
    const service = new ChatHistoryService(pool);

    const messages = await service.load('thread-1');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toBeInstanceOf(HumanMessage);
    expect(messages[0].content).toBe('你好');
  });

  it('在同一事务中替换会话窗口', async () => {
    const { pool, client } = createPool();
    const service = new ChatHistoryService(pool);

    await service.replace('thread-1', [new HumanMessage('新消息')]);

    const statements = (client.query as jest.Mock).mock.calls.map(([sql]) => sql);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toContain('DELETE FROM');
    expect(statements[2]).toContain('INSERT INTO');
    expect(statements[3]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('写入失败时回滚并释放连接', async () => {
    const { pool, client } = createPool();
    const insertError = new Error('insert failed');
    (client.query as jest.Mock).mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO')) return Promise.reject(insertError);
      return Promise.resolve({ rows: [] });
    });
    const service = new ChatHistoryService(pool);

    await expect(service.replace('thread-1', [new HumanMessage('新消息')])).rejects.toBe(
      insertError,
    );
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
