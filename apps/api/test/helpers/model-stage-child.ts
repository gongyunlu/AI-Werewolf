import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { GameRecoveryService } from '../../src/game-recovery/game-recovery.service';
import { stageModels } from './stage-models';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';

it('独立进程恢复每轮模型阶段及保守请求次数', async () => {
  const url = process.env.STAGE_TEST_DATABASE!;
  if (!/^\/werewolf_test_[a-f0-9]{32}$/.test(new URL(url).pathname))
    throw new Error('拒绝访问非测试数据库');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  }) as unknown as PrismaService;
  const recovery = new GameRecoveryService(prisma);
  const { calls, generations, traces } = stageModels(process.env.STAGE_TEST_URL!, recovery);
  const mode = process.env.STAGE_TEST_MODE;
  const original = calls.structured.bind(calls);
  let attempts = 0;
  calls.structured = (async (...args: Parameters<typeof calls.structured>) => {
    if (mode === 'repair-crash' && ++attempts === 2) process.exit(73);
    const output = await original(...args);
    if (mode === 'response-crash') process.exit(73);
    return output;
  }) as typeof calls.structured;
  try {
    const execution = await prisma.gameExecution.findUniqueOrThrow({
      where: { gameId: process.env.STAGE_TEST_GAME! },
    });
    await recovery.run(execution, new AbortController().signal, () =>
      recovery.node(0, 'test', {}, async () => {
        await generations.streamText(
          'script',
          [new HumanMessage('第一轮')],
          undefined,
          undefined,
          undefined,
          undefined,
          'thinking/0',
        );
        await generations.streamText(
          'script',
          [new HumanMessage('第二轮')],
          undefined,
          undefined,
          undefined,
          undefined,
          'thinking/1',
        );
        return generations.structured(
          'script',
          z.object({ action: z.literal('hold') }),
          [new HumanMessage('最终动作')],
          () => ({ callbacks: [], metadata: {}, tags: [], runName: 'final' }),
          undefined,
          undefined,
          undefined,
          undefined,
          'final',
        );
      }),
    );
  } finally {
    await traces.onModuleDestroy();
    await prisma.$disconnect();
  }
});
