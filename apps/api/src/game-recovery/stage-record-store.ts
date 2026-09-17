import type { ModelStageState, ModelStageStore } from '../llm/model-stage';
import type { PrismaService } from '../prisma/prisma.service';
import { decodeRecoveryValue, encodeRecoveryValue } from './recovery-value';
import { fenceExecution, type ExecutionIdentity } from './execution-fence';

/** 一次模型阶段的持久键：作用域只由调用方给出的前缀决定，状态本身不参与命名。 */
export function stageRecordKey(prefix: string, label: string): string {
  return `${prefix}/${label}`;
}

/**
 * 按键原子更新模型阶段记录，写入与执行权校验同事务。
 *
 * 请求前保存预算预占，响应后保存结果；预占后退出仍然计数，不退还可能已发出的请求。
 */
export function createStageRecordStore(options: {
  prisma: PrismaService;
  identity: ExecutionIdentity;
  prefix: string;
  signal?: AbortSignal;
}): ModelStageStore {
  return {
    update: async (label, change) => {
      const { prisma, identity, signal } = options;
      signal?.throwIfAborted();
      const key = stageRecordKey(options.prefix, label);
      return prisma.$transaction(async (tx) => {
        await fenceExecution(tx, identity);
        signal?.throwIfAborted();
        const old = await tx.gameExecutionStep.findUnique({
          where: { gameId_key: { gameId: identity.gameId, key } },
        });
        const state = change(old ? decodeRecoveryValue<ModelStageState>(old.output) : undefined);
        const data = {
          output: encodeRecoveryValue(state),
          completed: !!(state.output || state.failure),
        };
        await tx.gameExecutionStep.upsert({
          where: { gameId_key: { gameId: identity.gameId, key } },
          create: { gameId: identity.gameId, key, ...data },
          update: data,
        });
        signal?.throwIfAborted();
        return state;
      });
    },
  };
}
