import { ModelCallError } from '@/llm/model-call-guard';
import { ExperimentInvalidError } from '@/evaluation/experiment-integrity';
import type { NodeContext } from '../nodes/node.types';
import { gameLogger } from '../utils/game-logger';

/**
 * 模型调用失败一律上抛，不再产生替代行动。
 *
 * 替代行动会把失败伪装成一个合法回合，观战和评分都无法区分；调用层的重放已经覆盖了
 * 供应商偶发抖动，这里再把错误吞掉只会掩盖真问题。固定配置的实验局要额外判为无效，
 * 否则同一份实验数据里混进了降级回合。
 */
export function failModelCall(error: unknown, context: NodeContext, message: string): never {
  // 主动中止（暂停/取消/超时）与非模型故障原样上抛：它们不代表模型不可用。
  if (context.signal?.aborted || !(error instanceof ModelCallError)) throw error;
  gameLogger.error(`${message}: ${error.message}`);
  if (context.strictExperiment)
    throw new ExperimentInvalidError('固定配置实验不允许模型失败降级', { cause: error });
  throw error;
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
