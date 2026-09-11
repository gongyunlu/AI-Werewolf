import { ModelCallError } from '@/llm/model-call-guard';
import { ExperimentInvalidError } from '@/evaluation/experiment-integrity';
import type { NodeContext } from '../nodes/node.types';
import type { GameRecoveryService } from '@/game-recovery/game-recovery.service';

export class GameFailurePolicy {
  private fallbacks = 0;

  get count(): number {
    return this.fallbacks;
  }

  restore(count: number): void {
    this.fallbacks = count;
  }

  constructor(
    private readonly maxFallbacks: number,
    private readonly strict: boolean,
  ) {}

  consume(error: ModelCallError): void {
    if (this.strict)
      throw new ExperimentInvalidError('固定配置实验不允许模型失败降级', { cause: error });
    if (this.fallbacks >= this.maxFallbacks)
      throw new Error(
        `对局模型降级次数已耗尽 (${this.fallbacks}/${this.maxFallbacks}): ${error.message}`,
        { cause: error },
      );
    this.fallbacks++;
  }

  async consumePersisted(
    error: ModelCallError,
    recovery: GameRecoveryService,
    action: string,
  ): Promise<void> {
    if (this.strict)
      throw new ExperimentInvalidError('固定配置实验不允许模型失败降级', { cause: error });
    const count = await recovery.effect(`fallback/${action}`, async (tx) => {
      const used = await tx.gameExecutionStep.count({
        where: {
          gameId: recovery.current!.execution.gameId,
          completed: true,
          key: { contains: '/fallback/' },
        },
      });
      if (used >= this.maxFallbacks)
        throw new Error(`对局模型降级次数已耗尽 (${used}/${this.maxFallbacks}): ${error.message}`, {
          cause: error,
        });
      return used + 1;
    });
    this.fallbacks = Math.max(this.fallbacks, count);
  }
}

export function allowModelFallback(
  error: unknown,
  context: NodeContext,
  action = 'action',
): void | Promise<void> {
  if (context.signal?.aborted || !(error instanceof ModelCallError)) throw error;
  if (context.recovery?.current && context.failurePolicy)
    return context.failurePolicy.consumePersisted(error, context.recovery, action);
  context.failurePolicy?.consume(error);
}

/** 等待同批工作退出后再上抛，防止 Worker 已结束而其他玩家仍在写事件。 */
export async function settleGameActions<T>(actions: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(actions);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

/** 提交开始后的故障只能退出，不能被外层当作可降级的模型错误。 */
export function failAfterEffect(error: unknown): never {
  if (error instanceof ModelCallError)
    throw new Error('领域效果提交或后处理失败', { cause: error });
  throw error;
}
