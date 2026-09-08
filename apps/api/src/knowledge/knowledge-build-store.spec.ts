import { storeKnowledgeChunk, writeKnowledgeEmbedding } from './knowledge-build-store';
import { knowledgeEmbeddingText } from './knowledge-policy';

it('两个构建者对同一来源产出不同蒸馏结果时，两者都为数据库赢家正文生成向量', async () => {
  let winner: any;
  const prisma = {
    knowledgeChunk: {
      upsert: jest.fn(async ({ create }) => {
        winner ??= { id: 'id', ...create };
        return winner;
      }),
    },
  };
  const common = {
    version: 'v',
    sourceHash: 'hash',
    sourceFile: 'f',
    articleTitle: 'title',
    content: '原文',
    role: 'seer',
    scenario: 'night_action',
    trigger: 'first night',
  };
  const [a, b] = await Promise.all([
    storeKnowledgeChunk(prisma as never, { ...common, action: 'A tactics' }),
    storeKnowledgeChunk(prisma as never, { ...common, action: 'B tactics' }),
  ]);
  expect(a).toEqual(b);
  expect(a.content).toBe(knowledgeEmbeddingText(winner));
  expect(a.content).not.toContain('B tactics');
});

it('正文比较未命中时拒绝声称 embedding 写入成功', async () => {
  const prisma = { $executeRaw: jest.fn().mockResolvedValue(0) };
  await expect(
    writeKnowledgeEmbedding(prisma as never, { id: 'id', content: 'old' }, [1], 'm'),
  ).rejects.toThrow('发生变化');
});
