import type { PrismaService } from '../../src/prisma/prisma.service';
import type { RecoveryManifest } from '../../src/game-recovery/game-recovery.service';
import { encodeRecoveryValue } from '../../src/game-recovery/recovery-value';

/** 提交器测试直接构造执行上下文；启动原子性由启动集成套件覆盖。 */
export function createTestExecution(
  prisma: PrismaService,
  gameId: string,
  initialState: unknown,
  manifest: RecoveryManifest,
  deadline: Date,
) {
  return prisma.gameExecution.create({
    data: {
      gameId,
      initialState: encodeRecoveryValue(initialState),
      manifest: encodeRecoveryValue(manifest),
      deadline,
      dispatchPending: true,
    },
  });
}

/** 仅用于提交器的重放测试；每次重放显式创建新代，不能重复领取旧代。 */
export async function nextTestExecution(prisma: PrismaService, gameId: string) {
  const execution = await prisma.gameExecution.findUniqueOrThrow({ where: { gameId } });
  if (execution.dispatchPending || execution.owner) return execution;
  return prisma.gameExecution.update({
    where: { gameId },
    data: {
      generation: { increment: 1 },
      dispatchPending: true,
    },
  });
}
