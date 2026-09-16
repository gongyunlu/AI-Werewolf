import { readFile, writeFile } from 'node:fs/promises';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { GameRecoveryService } from '../../src/game-recovery/game-recovery.service';
import { EventWriterService } from '../../src/game-engine/events/event-writer.service';
import { createVoteFixture, voteBatch } from './vote-fixture';

jest.mock('@langchain/openai', () => ({
  OpenAIClient: jest.requireActual('@langchain/openai').OpenAIClient,
  ChatOpenAI: jest.fn(),
}));

it('在独立进程生成或提交普通投票，退出时不执行清理', async () => {
  const connectionString = process.env.VOTE_TEST_DATABASE!;
  if (!/^\/werewolf_test_[a-f0-9]{32}$/.test(new URL(connectionString).pathname))
    throw new Error('子进程拒绝访问非测试数据库');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  }) as unknown as PrismaService;
  const gameId = process.env.VOTE_TEST_GAME!;
  const path = process.env.VOTE_TEST_ARTIFACT!;
  const mode = process.env.VOTE_TEST_MODE!;
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('子进程禁止外部请求'));
  const fixture = mode === 'generate' ? await createVoteFixture(prisma, gameId) : undefined;
  const recovery = fixture?.game.recovery ?? new GameRecoveryService(prisma);
  const execution = await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } });
  await recovery.run(execution, new AbortController().signal, () =>
    recovery.node(0, 'vote', {}, async () => {
      if (fixture) await writeFile(path, JSON.stringify(await fixture.generate()), 'utf8');
      else {
        const turns = JSON.parse(await readFile(path, 'utf8'));
        const events = await new EventWriterService(prisma, recovery).writeVoteBatch(
          voteBatch(turns),
        );
        if (mode === 'replay') await writeFile(path + '.result', JSON.stringify(events), 'utf8');
      }
      expect(globalThis.fetch).not.toHaveBeenCalled();
      process.exit(73);
    }),
  );
});
