import { GAME_STATUSES } from '@ai-werewolf/shared';
import type { Prisma } from '../generated/prisma/client';

export class ExecutionOwnershipError extends Error {
  constructor() {
    super('当前执行者已失去对局执行权');
  }
}

/** 执行权归属：换代或换人后，旧执行者的写入必须整体失败。 */
export interface ExecutionIdentity {
  gameId: string;
  generation: number;
  owner: string;
}

/**
 * 在调用方事务内校验执行权、运行期限并刷新心跳。
 *
 * 失权或超期即抛出，与同一事务里的业务写入一起回滚；终局结果仍允许核实重放。
 */
export async function fenceExecution(
  tx: Prisma.TransactionClient,
  identity: ExecutionIdentity,
  allowFinished = false,
): Promise<void> {
  const [checked] = await tx.gameExecution.updateManyAndReturn({
    where: {
      gameId: identity.gameId,
      generation: identity.generation,
      owner: identity.owner,
      game: {
        status: allowFinished
          ? { in: [GAME_STATUSES.RUNNING, GAME_STATUSES.FINISHED] }
          : GAME_STATUSES.RUNNING,
      },
    },
    data: { heartbeatAt: new Date() },
    select: { deadline: true, game: { select: { status: true } } },
  });
  if (!checked) throw new ExecutionOwnershipError();
  // 取得行锁后再判断，等待锁的时间也计入原期限。
  if (checked.game.status === GAME_STATUSES.RUNNING) {
    if (!checked.deadline) throw new Error('执行中的对局缺少原定期限');
    if (checked.deadline.getTime() <= Date.now()) throw new Error('对局原定运行期限已到');
  }
}
