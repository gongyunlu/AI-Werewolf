import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { GameExecution, Prisma } from '../generated/prisma/client';
import type { FrozenPrompts } from '../evaluation/experiment-snapshot';
import {
  ModelCallError,
  type ModelFailureCode,
  type ModelFailureDetails,
} from '../llm/model-call-guard';
import { decodeRecoveryValue, encodeRecoveryValue } from './recovery-value';

/** version 只保护持久化格式本身；格式不变的其他差异一律允许续跑。 */
export interface RecoveryManifest {
  version: 1;
  prompts: FrozenPrompts;
}

interface ExecutionScope {
  execution: GameExecution;
  owner: string;
  manifest: RecoveryManifest;
  prefix: string;
  counters: Map<string, number>;
  signal: AbortSignal;
  visibleThrough?: number;
}

type SavedResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ModelFailureCode; retryAt?: number; details: ModelFailureDetails };

export class ExecutionOwnershipError extends Error {
  constructor() {
    super('当前执行者已失去对局执行权');
  }
}

/** 节点结果、模型输入输出和领域写入使用同一局的持久执行记录。 */
@Injectable()
export class GameRecoveryService {
  private readonly storage = new AsyncLocalStorage<ExecutionScope>();

  constructor(private readonly prisma: PrismaService) {}

  get current() {
    return this.storage.getStore();
  }

  async create(gameId: string, initialState: unknown, manifest: RecoveryManifest, deadline: Date) {
    return this.prisma.gameExecution.upsert({
      where: { gameId },
      update: {},
      create: {
        gameId,
        initialState: encodeRecoveryValue(initialState),
        manifest: encodeRecoveryValue(manifest),
        deadline,
      },
    });
  }

  async run<T>(
    execution: GameExecution,
    signal: AbortSignal,
    callback: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const owner = randomUUID();
    const claimed = await this.prisma.gameExecution.updateMany({
      where: {
        gameId: execution.gameId,
        generation: execution.generation,
        owner: null,
        game: { status: GAME_STATUSES.RUNNING },
      },
      data: { owner, heartbeatAt: new Date(), dispatchPending: false },
    });
    if (!claimed.count) throw new ExecutionOwnershipError();
    const controller = new AbortController();
    const combinedSignal = AbortSignal.any([
      signal,
      controller.signal,
      AbortSignal.timeout(Math.max(0, execution.deadline.getTime() - Date.now())),
    ]);
    const scope: ExecutionScope = {
      execution,
      owner,
      signal: combinedSignal,
      manifest: decodeRecoveryValue(execution.manifest),
      prefix: '',
      counters: new Map(),
    };
    let heartbeat: Promise<unknown> | undefined;
    const timer = setInterval(() => {
      if (heartbeat) return;
      heartbeat = this.prisma.gameExecution
        .updateMany({
          where: { gameId: execution.gameId, generation: execution.generation, owner },
          data: { heartbeatAt: new Date() },
        })
        .then((updated) => {
          if (!updated.count) controller.abort(new ExecutionOwnershipError());
          return updated.count;
        })
        .catch((error) => controller.abort(error))
        .finally(() => {
          heartbeat = undefined;
        });
    }, 10_000);
    timer.unref();
    try {
      return await this.storage.run(scope, () => callback(combinedSignal));
    } finally {
      clearInterval(timer);
      await heartbeat;
      await this.prisma.gameExecution.updateMany({
        where: { gameId: execution.gameId, generation: execution.generation, owner },
        data: { owner: null },
      });
    }
  }

  /** 每个节点保存进入时的状态；未完成节点内的已完成调用会被逐项复用。 */
  async node<S, T>(
    ordinal: number,
    name: string,
    state: S,
    callback: (input: S) => Promise<T>,
  ): Promise<T> {
    const scope = this.current;
    if (!scope) return callback(state);
    scope.signal.throwIfAborted();
    const key = `node/${ordinal}/${name}`;
    let step = await this.read(scope, key);
    if (step?.completed) return this.unpack<T>(step.output);
    if (!step) {
      const latest = await this.prisma.event.findFirst({
        where: { gameId: scope.execution.gameId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      step = await this.prisma.$transaction(async (tx) => {
        await this.fence(tx, scope);
        return tx.gameExecutionStep.create({
          data: {
            gameId: scope.execution.gameId,
            key,
            input: encodeRecoveryValue({ state, visibleThrough: latest?.sequence ?? 0 }),
          },
        });
      });
    }
    const input = decodeRecoveryValue<{ state: S; visibleThrough: number }>(step.input);
    const nested: ExecutionScope = {
      ...scope,
      prefix: `${key}/`,
      counters: new Map(),
      visibleThrough: ['vote', 'pkVote', 'wolfExplode'].includes(name)
        ? input.visibleThrough
        : undefined,
    };
    const value = await this.storage.run(nested, () => callback(input.state));
    await this.save(scope, key, { ok: true, value });
    return value;
  }

  /** 模型结果先落库，再交给节点执行；取消和程序错误不伪装成可复用结果。 */
  async value<T>(label: string, callback: () => Promise<T>): Promise<T> {
    const scope = this.current;
    if (!scope) return callback();
    scope.signal.throwIfAborted();
    const key = this.nextKey(scope, label);
    const existing = await this.read(scope, key);
    scope.signal.throwIfAborted();
    if (existing?.completed) return this.unpack<T>(existing.output);
    let result: SavedResult<T>;
    try {
      const value = await this.storage.run(
        { ...scope, prefix: `${key}/`, counters: new Map() },
        callback,
      );
      result = { ok: true, value };
    } catch (error) {
      if (scope.signal.aborted || !(error instanceof ModelCallError)) throw error;
      result = { ok: false, code: error.code, retryAt: error.retryAt, details: error.details };
    }
    scope.signal.throwIfAborted();
    await this.save(scope, key, result);
    return this.unwrap(result);
  }

  /** 效果与完成记录同事务提交。响应丢失后返回同一条效果，不生成替代动作。 */
  async effect<T>(
    label: string,
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const scope = this.current;
    if (!scope) return callback(this.prisma);
    scope.signal.throwIfAborted();
    const key = this.nextKey(scope, label);
    return this.prisma.$transaction(async (tx) => {
      await this.fence(tx, scope, true);
      const saved = await tx.gameExecutionStep.findUnique({
        where: { gameId_key: { gameId: scope.execution.gameId, key } },
      });
      if (saved?.completed) return this.unpack<T>(saved.output);
      await this.fence(tx, scope);
      const value = await callback(tx);
      scope.signal.throwIfAborted();
      await tx.gameExecutionStep.create({
        data: {
          gameId: scope.execution.gameId,
          key,
          completed: true,
          output: encodeRecoveryValue({ ok: true, value }),
        },
      });
      scope.signal.throwIfAborted();
      return value;
    });
  }

  async recordedEffects<T>(label: string): Promise<T[]> {
    const scope = this.current;
    if (!scope) return [];
    const steps = await this.prisma.gameExecutionStep.findMany({
      where: {
        gameId: scope.execution.gameId,
        key: { startsWith: `${scope.prefix}${label}` },
        completed: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return steps.map((step) => this.unpack<T>(step.output));
  }

  async withVisibility<T>(label: string, callback: () => Promise<T>): Promise<T> {
    const scope = this.current;
    if (!scope) return callback();
    const visibleThrough = await this.value(`visibility/${label}`, async () => {
      const event = await this.prisma.event.findFirst({
        where: { gameId: scope.execution.gameId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      return event?.sequence ?? 0;
    });
    return this.storage.run({ ...scope, visibleThrough }, callback);
  }

  /** 只在队列已确认任务失锁后调用；启动另一个 API 本身不是中断证据。 */
  async interrupt(gameId: string, generation?: number) {
    return this.prisma.$transaction(async (tx) => {
      // 与领域提交保持 execution → game 的加锁顺序。
      await tx.gameExecution.updateMany({
        where: { gameId },
        data: { generation: { increment: 0 } },
      });
      const execution = await tx.gameExecution.findUnique({ where: { gameId } });
      if (!execution) {
        // 建立检查点前退出、实验局和其他板型无法续跑，不能显示没有能力支撑的待恢复。
        const stopped = await tx.game.updateMany({
          where: { id: gameId, status: GAME_STATUSES.RUNNING, execution: null },
          data: { status: GAME_STATUSES.ABORTED, endedAt: new Date() },
        });
        return stopped.count > 0;
      }
      const changed = await tx.game.updateMany({
        where: {
          id: gameId,
          status: GAME_STATUSES.RUNNING,
          ...(generation === undefined ? {} : { execution: { generation } }),
        },
        data: { status: GAME_STATUSES.PENDING_RECOVERY },
      });
      if (changed.count)
        await tx.gameExecution.updateMany({
          where: { gameId },
          data: { generation: { increment: 1 }, owner: null },
        });
      return changed.count > 0;
    });
  }

  async prepareResume(gameId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.gameExecution.updateMany({
        where: { gameId },
        data: { generation: { increment: 0 } },
      });
      const execution = await tx.gameExecution.findUnique({ where: { gameId } });
      if (!execution) throw new ConflictException('此对局没有执行检查点，不能恢复历史对局');
      const manifest = decodeRecoveryValue<RecoveryManifest>(execution.manifest);
      if (manifest.version !== 1)
        throw new ConflictException('执行检查点的存储格式不受支持，无法恢复');
      if (execution.deadline.getTime() <= Date.now())
        throw new ConflictException('对局原定运行期限已到，不能延长期限恢复');
      const game = await tx.game.findUnique({ where: { id: gameId }, select: { status: true } });
      if (game?.status === GAME_STATUSES.RUNNING && execution.dispatchPending) return execution;
      const claimed = await tx.game.updateMany({
        where: { id: gameId, status: GAME_STATUSES.PENDING_RECOVERY },
        data: { status: GAME_STATUSES.RUNNING },
      });
      if (!claimed.count) throw new ConflictException('只有待恢复的对局可以恢复');
      return tx.gameExecution.update({
        where: { gameId },
        data: { generation: { increment: 1 }, owner: null, dispatchPending: true },
      });
    });
  }

  async renewDispatch(gameId: string, generation: number) {
    return this.prisma.$transaction(async (tx) => {
      await tx.gameExecution.updateMany({
        where: { gameId },
        data: { generation: { increment: 0 } },
      });
      const execution = await tx.gameExecution.findUniqueOrThrow({ where: { gameId } });
      const game = await tx.game.findUniqueOrThrow({
        where: { id: gameId },
        select: { status: true },
      });
      if (game.status !== GAME_STATUSES.RUNNING || !execution.dispatchPending)
        throw new ConflictException('恢复任务已经开始执行或对局状态已变化');
      if (execution.generation !== generation) return execution;
      // 终态队列任务可能保留失锁标记；创建新一代任务，保留原检查点。
      return tx.gameExecution.update({ where: { gameId }, data: { generation: { increment: 1 } } });
    });
  }

  private nextKey(scope: ExecutionScope, label: string) {
    const count = scope.counters.get(label) ?? 0;
    scope.counters.set(label, count + 1);
    return `${scope.prefix}${label}/${count}`;
  }

  private read(scope: ExecutionScope, key: string) {
    return this.prisma.gameExecutionStep.findUnique({
      where: { gameId_key: { gameId: scope.execution.gameId, key } },
    });
  }

  private async fence(tx: Prisma.TransactionClient, scope: ExecutionScope, allowFinished = false) {
    const checked = await tx.gameExecution.updateMany({
      where: {
        gameId: scope.execution.gameId,
        generation: scope.execution.generation,
        owner: scope.owner,
        game: {
          status: allowFinished
            ? { in: [GAME_STATUSES.RUNNING, GAME_STATUSES.FINISHED] }
            : GAME_STATUSES.RUNNING,
        },
      },
      data: { heartbeatAt: new Date() },
    });
    if (!checked.count) throw new ExecutionOwnershipError();
  }

  private async save<T>(scope: ExecutionScope, key: string, value: SavedResult<T>) {
    scope.signal.throwIfAborted();
    await this.prisma.$transaction(async (tx) => {
      await this.fence(tx, scope, true);
      const output = encodeRecoveryValue(value);
      await tx.gameExecutionStep.upsert({
        where: { gameId_key: { gameId: scope.execution.gameId, key } },
        create: { gameId: scope.execution.gameId, key, output, completed: true },
        update: { output, completed: true },
      });
      scope.signal.throwIfAborted();
    });
  }

  private unpack<T>(output: unknown): T {
    return this.unwrap(decodeRecoveryValue<SavedResult<T>>(output));
  }
  private unwrap<T>(result: SavedResult<T>): T {
    if (!result.ok)
      throw new ModelCallError(result.code, undefined, result.retryAt, result.details);
    return result.value;
  }
}
