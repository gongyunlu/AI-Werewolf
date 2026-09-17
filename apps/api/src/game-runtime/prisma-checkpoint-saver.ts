import {
  BaseCheckpointSaver,
  copyCheckpoint,
  WRITES_IDX_MAP,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { fenceExecution, type ExecutionIdentity } from '../game-recovery/execution-fence';

interface Located {
  gameId: string;
  checkpointNs: string;
  checkpointId?: string;
}

interface LocatedAt extends Located {
  checkpointId: string;
}

/**
 * 用现有对局库保存图执行进度，线程即对局。
 *
 * 写入与业务执行权同事务：换代后的旧执行者写不进任何进度。
 * 读取不做执行权校验——进度属于对局本身，谁能读由调用方决定。
 * 序列化交给基类的 serde，不自行维护编码格式。
 *
 * 存储命名空间取构造时给定的节点实例：框架会把根图的 `checkpoint_ns` 重置为空串，
 * 交给它就无法把同一局的不同轮次分开，后一轮会被当成前一轮的续跑。
 */
export class PrismaCheckpointSaver extends BaseCheckpointSaver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: ExecutionIdentity,
    private readonly phaseInstanceId: string,
    private readonly signal?: AbortSignal,
  ) {
    super();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { gameId, checkpointNs, checkpointId } = this.locate(config);
    const row = checkpointId
      ? await this.prisma.graphCheckpoint.findUnique({
          where: { gameId_checkpointNs_checkpointId: { gameId, checkpointNs, checkpointId } },
        })
      : await this.prisma.graphCheckpoint.findFirst({
          where: { gameId, checkpointNs },
          orderBy: { checkpointId: 'desc' },
        });
    return row ? this.toTuple(row) : undefined;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const { gameId, checkpointNs } = this.locate(config);
    const rows = await this.prisma.graphCheckpoint.findMany({
      where: {
        gameId,
        ...(checkpointNs ? { checkpointNs } : {}),
        ...(options?.before?.configurable?.checkpoint_id
          ? { checkpointId: { lt: options.before.configurable.checkpoint_id } }
          : {}),
      },
      orderBy: { checkpointId: 'desc' },
    });
    let remaining = options?.limit ?? Infinity;
    for (const row of rows) {
      const tuple = await this.toTuple(row);
      if (
        options?.filter &&
        !Object.entries(options.filter).every(
          ([key, value]) => (tuple.metadata as Record<string, unknown>)?.[key] === value,
        )
      )
        continue;
      if (remaining <= 0) return;
      remaining -= 1;
      yield tuple;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const { gameId, checkpointNs } = this.locate(config);
    const prepared = copyCheckpoint(checkpoint);
    const checkpointValue = await this.encode(prepared);
    const metadataValue = await this.encode(metadata);
    await this.write(async (tx) => {
      const key = {
        gameId,
        checkpointNs,
        checkpointId: prepared.id,
      };
      await tx.graphCheckpoint.upsert({
        where: { gameId_checkpointNs_checkpointId: key },
        create: {
          ...key,
          parentCheckpointId: config.configurable?.checkpoint_id ?? null,
          checkpoint: checkpointValue,
          metadata: metadataValue,
        },
        update: { checkpoint: checkpointValue, metadata: metadataValue },
      });
    });
    return {
      configurable: { thread_id: gameId, checkpoint_ns: checkpointNs, checkpoint_id: prepared.id },
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const located = this.locateAt(config);
    const encoded = await Promise.all(
      writes.map(async ([channel, value], position) => ({
        // 框架内部通道用负下标，与常规写入的位置下标区分开。
        idx: WRITES_IDX_MAP[channel] ?? position,
        channel,
        value: await this.encode(value),
      })),
    );
    await this.write(async (tx) => {
      for (const write of encoded) {
        const where = {
          gameId: located.gameId,
          checkpointNs: located.checkpointNs,
          checkpointId: located.checkpointId,
          taskId,
          idx: write.idx,
        };
        const data = { channel: write.channel, value: write.value };
        // 常规写入按位置幂等；内部通道允许覆盖，与基类语义一致。
        await tx.graphCheckpointWrite.upsert({
          where: { gameId_checkpointNs_checkpointId_taskId_idx: where },
          create: { ...where, ...data },
          update: write.idx < 0 ? data : {},
        });
      }
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    this.assertGame(threadId);
    await this.write(async (tx) => {
      await tx.graphCheckpointWrite.deleteMany({ where: { gameId: threadId } });
      await tx.graphCheckpoint.deleteMany({ where: { gameId: threadId } });
    });
  }

  private async toTuple(row: {
    gameId: string;
    checkpointNs: string;
    checkpointId: string;
    parentCheckpointId: string | null;
    checkpoint: Prisma.JsonValue;
    metadata: Prisma.JsonValue | null;
  }): Promise<CheckpointTuple> {
    const writes = await this.prisma.graphCheckpointWrite.findMany({
      where: {
        gameId: row.gameId,
        checkpointNs: row.checkpointNs,
        checkpointId: row.checkpointId,
      },
      orderBy: [{ taskId: 'asc' }, { idx: 'asc' }],
    });
    const pendingWrites = await Promise.all(
      writes.map(
        async (write) =>
          [write.taskId, write.channel, await this.decode(write.value)] as CheckpointPendingWrite,
      ),
    );
    const configurable = {
      thread_id: row.gameId,
      checkpoint_ns: row.checkpointNs,
      checkpoint_id: row.checkpointId,
    };
    return {
      config: { configurable },
      checkpoint: (await this.decode(row.checkpoint)) as Checkpoint,
      metadata: (await this.decode(row.metadata)) as CheckpointMetadata,
      pendingWrites,
      ...(row.parentCheckpointId
        ? {
            parentConfig: {
              configurable: { ...configurable, checkpoint_id: row.parentCheckpointId },
            },
          }
        : {}),
    };
  }

  private async write(run: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
    this.signal?.throwIfAborted();
    await this.prisma.$transaction(async (tx) => {
      await fenceExecution(tx, this.identity);
      this.signal?.throwIfAborted();
      await run(tx);
      this.signal?.throwIfAborted();
    });
  }

  private locate(config: RunnableConfig): Located {
    const configurable = config.configurable ?? {};
    this.assertGame(configurable.thread_id);
    return {
      gameId: this.identity.gameId,
      checkpointNs: this.phaseInstanceId,
      checkpointId: configurable.checkpoint_id,
    };
  }

  private locateAt(config: RunnableConfig): LocatedAt {
    const located = this.locate(config);
    if (!located.checkpointId) throw new Error('写入分支结果需要当前检查点标识');
    return { ...located, checkpointId: located.checkpointId };
  }

  private assertGame(threadId: string | undefined): void {
    if (threadId !== this.identity.gameId) throw new Error('检查点线程与当前对局不一致，拒绝访问');
  }

  private async encode(value: unknown): Promise<Prisma.InputJsonValue> {
    const [type, bytes] = await this.serde.dumpsTyped(value);
    if (type !== 'json') throw new Error(`图执行进度出现 ${type} 类型，当前存储只承载 JSON 值`);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  private decode(value: Prisma.JsonValue): Promise<unknown> {
    return this.serde.loadsTyped('json', JSON.stringify(value));
  }
}
