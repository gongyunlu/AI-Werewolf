import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { GamesService } from '../../src/games/games.service';
import { createMockGame } from '../../src/game-engine/testing/mock-game-harness';
import * as roleAssignment from '../../src/game-engine/rules/role-assignment';

jest.mock('@langchain/openai', () => ({
  OpenAIClient: jest.requireActual('@langchain/openai').OpenAIClient,
  ChatOpenAI: jest.fn(),
}));

it('接受启动后立即退出，不执行清理与投递', async () => {
  const connectionString = process.env.DISPATCH_TEST_DATABASE!;
  if (!/^\/werewolf_test_[a-f0-9]{32}$/.test(new URL(connectionString).pathname))
    throw new Error('子进程拒绝访问非测试数据库');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  }) as unknown as PrismaService;
  const gameId = process.env.DISPATCH_TEST_GAME!;
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('子进程禁止外部请求'));
  const assign = roleAssignment.assignRolesAndSeats;
  jest.spyOn(roleAssignment, 'assignRolesAndSeats').mockImplementation((...args) => {
    const shuffle = jest.spyOn(Math, 'random').mockReturnValue(0.999999);
    try {
      return assign(...args);
    } finally {
      shuffle.mockRestore();
    }
  });
  const game = await createMockGame('villager', {}, { prisma, gameId, recovery: true });
  await new GamesService(prisma, game.executor, game.broadcaster as never, {} as never).startGame(
    gameId,
  );
  // 故意跳过模块关闭、连接清理与任何队列操作，验证恢复不依赖 finally。
  process.exit(73);
});
