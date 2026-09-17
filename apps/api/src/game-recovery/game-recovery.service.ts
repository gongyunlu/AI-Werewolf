import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, Optional } from '@nestjs/common';
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
import { ExecutionOwnershipError, fenceExecution } from './execution-fence';
import { createStageRecordStore } from './stage-record-store';
import { SseBroadcasterService } from '../sse/sse-broadcaster.service';
import type { ModelStageStore } from '../llm/model-stage';

/** version 同时约束旧执行器的步骤顺序与持久格式，改变步骤键时必须升级。 */
export interface RecoveryManifest {
  version: 1 | 2;
  prompts: FrozenPrompts;
}

function supportsManifest(value: Partial<RecoveryManifest> | null): value is RecoveryManifest {
  return (
    (value?.version === 1 || value?.version === 2) &&
    !!value.prompts &&
    typeof value.prompts === 'object' &&
    !Array.isArray(value.prompts)
  );
}

interface ExecutionScope {
  execution: GameExecution & { deadline: Date };
  owner: string;
  manifest: RecoveryManifest;
  prefix: string;
  counters: Map<string, number>;
  signal: AbortSignal;
  visibleThrough?: number;
}

/** 投递元数据用于所有对局；中断后续跑仅支持当前普通六人局。 */
export function canRecoverGame(
  game: { rulesetId: string; skillVersion: string; experiment: unknown },
  manifest: unknown,
): boolean {
  const value = decodeRecoveryValue<Partial<RecoveryManifest> | null>(manifest);
  return (
    game.rulesetId === 'standard6p' &&
    game.skillVersion === 'v1' &&
    game.experiment === null &&
    supportsManifest(value)
  );
}

type SavedResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ModelFailureCode; retryAt?: number; details: ModelFailureDetails };

export { ExecutionOwnershipError } from './execution-fence';

/** 节点结果、模型输入输出和领域写入使用同一局的持久执行记录。 */
@Injectable()
export class GameRecoveryService {
  private readonly storage = new AsyncLocalStorage<ExecutionScope>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly broadcaster?: SseBroadcasterService,
  ) {}

  get current() {
    return this.storage.getStore();
  }

  modelStageStore(): ModelStageStore | undefined {
    const scope = this.current;
    if (!scope) return undefined;
    const store = createStageRecordStore({
      prisma: this.prisma,
      identity: {
        gameId: scope.execution.gameId,
        generation: scope.execution.generation,
        owner: scope.owner,
      },
      prefix: `${scope.prefix}model-stage`,
      signal: scope.signal,
    });
    return {
      update: (label, change) => {
        scope.signal.throwIfAborted();
        if (scope.manifest.version !== 2)
          throw new ConflictException('旧执行记录缺少单次请求预算，不能重启尚未保存的模型阶段');
        return store.update(label, change);
      },
    };
  }

  async run<T>(
    execution: GameExecution,
    signal: AbortSignal,
    callback: (signal: AbortSignal) => Promise<T>,
    maxDurationMs?: number,
  ): Promise<T> {
    const owner = randomUUID();
    const claimed = await this.prisma.$transaction(async (tx) => {
      await tx.gameExecution.updateMany({
        where: { gameId: execution.gameId },
        data: { generation: { increment: 0 } },
      });
      const current = await tx.gameExecution.findUniqueOrThrow({
        where: { gameId: execution.gameId },
      });
      if (current.generation !== execution.generation || current.owner || !current.dispatchPending)
        throw new ExecutionOwnershipError();
      const manifest = decodeRecoveryValue<RecoveryManifest>(current.manifest);
      if (!supportsManifest(manifest))
        throw new ConflictException('执行记录的版本或冻结输入不受支持');
      if (!current.deadline && current.heartbeatAt)
        throw new ConflictException('已经开始执行的对局缺少原定期限');
      if (!current.deadline && (!maxDurationMs || maxDurationMs <= 0))
        throw new ConflictException('首次领取缺少有效运行时限');
      const deadline = current.deadline ?? new Date(Date.now() + maxDurationMs!);
      if (deadline.getTime() <= Date.now()) throw new ConflictException('对局原定运行期限已到');
      const updated = await tx.gameExecution.updateMany({
        where: {
          gameId: execution.gameId,
          generation: execution.generation,
          owner: null,
          dispatchPending: true,
          game: { status: GAME_STATUSES.RUNNING },
        },
        data: { owner, deadline, heartbeatAt: new Date(), dispatchPending: false },
      });
      if (!updated.count) throw new ExecutionOwnershipError();
      return { ...current, owner, deadline, dispatchPending: false };
    });
    const controller = new AbortController();
    const combinedSignal = AbortSignal.any([
      signal,
      controller.signal,
      AbortSignal.timeout(Math.max(0, claimed.deadline.getTime() - Date.now())),
    ]);
    const scope: ExecutionScope = {
      execution: claimed,
      owner,
      signal: combinedSignal,
      manifest: decodeRecoveryValue(claimed.manifest),
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
    options?: {
      replay: (tx: Prisma.TransactionClient, saved: T) => Promise<T>;
      /** 仅供自带业务键与终态写入保护的提交器核实原结果。 */
      allowFinished?: boolean;
    },
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
      if (saved?.completed) {
        const value = this.unpack<T>(saved.output);
        const result = options ? await options.replay(tx, value) : value;
        scope.signal.throwIfAborted();
        return result;
      }
      await this.fence(tx, scope, options?.allowFinished);
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
    const interrupted = await this.prisma.$transaction(async (tx) => {
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
      if (generation !== undefined && execution.generation !== generation) return false;
      // 队列失锁发生在领取前时，冻结输入仍完整，只需重新投递。
      if (execution.dispatchPending && !execution.owner) return false;
      const game = await tx.game.findUniqueOrThrow({ where: { id: gameId } });
      const recoverable = canRecoverGame(game, execution.manifest) && !!execution.deadline;
      const changed = await tx.game.updateMany({
        where: {
          id: gameId,
          status: GAME_STATUSES.RUNNING,
          ...(generation === undefined ? {} : { execution: { generation } }),
        },
        data: recoverable
          ? { status: GAME_STATUSES.PENDING_RECOVERY }
          : { status: GAME_STATUSES.ABORTED, endedAt: new Date() },
      });
      if (changed.count)
        await tx.gameExecution.updateMany({
          where: { gameId },
          data: { generation: { increment: 1 }, owner: null, dispatchPending: false },
        });
      return changed.count > 0;
    });
    if (interrupted) this.broadcaster?.complete(gameId);
    return interrupted;
  }

  async prepareResume(gameId: string) {
    let resumed = false;
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.gameExecution.updateMany({
        where: { gameId },
        data: { generation: { increment: 0 } },
      });
      const execution = await tx.gameExecution.findUnique({ where: { gameId } });
      if (!execution) throw new ConflictException('此对局没有执行检查点，不能恢复历史对局');
      const game = await tx.game.findUniqueOrThrow({ where: { id: gameId } });
      if (!canRecoverGame(game, execution.manifest))
        throw new ConflictException('只支持当前版本普通六人局的中断恢复');
      if (!execution.deadline)
        throw new ConflictException('对局尚未领取或缺少原定期限，应检查启动投递');
      if (execution.deadline.getTime() <= Date.now())
        throw new ConflictException('对局原定运行期限已到，不能延长期限恢复');
      if (game?.status === GAME_STATUSES.RUNNING && execution.dispatchPending) return execution;
      const claimed = await tx.game.updateMany({
        where: { id: gameId, status: GAME_STATUSES.PENDING_RECOVERY },
        data: { status: GAME_STATUSES.RUNNING },
      });
      if (!claimed.count) throw new ConflictException('只有待恢复的对局可以恢复');
      resumed = true;
      return tx.gameExecution.update({
        where: { gameId },
        data: { generation: { increment: 1 }, owner: null, dispatchPending: true },
      });
    });
    if (resumed) this.broadcaster?.complete(gameId);
    return result;
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

  private fence(tx: Prisma.TransactionClient, scope: ExecutionScope, allowFinished = false) {
    return fenceExecution(
      tx,
      {
        gameId: scope.execution.gameId,
        generation: scope.execution.generation,
        owner: scope.owner,
      },
      allowFinished,
    );
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
