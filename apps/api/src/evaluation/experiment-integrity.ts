import type { PrismaService } from '../prisma/prisma.service';
import type { ExperimentSnapshot } from './experiment-snapshot';

/** 实验失效属于主动中止，沿用节点的 AbortError 传播路径，禁止普通行为降级。 */
export class ExperimentInvalidError extends Error {
  override name = 'AbortError';
}

export function assertExperimentConfiguration(
  snapshot: ExperimentSnapshot,
  embeddingModel: string,
): void {
  if (snapshot.invalid) throw new ExperimentInvalidError(snapshot.invalid.reason);
  if (snapshot.embeddingModel !== embeddingModel)
    throw new ExperimentInvalidError('实验 embedding 模型已改变');
  if (!Number.isFinite(Date.parse(snapshot.capturedAt)))
    throw new ExperimentInvalidError('实验时钟输入缺失');
}

export async function abortExperiment(
  prisma: PrismaService,
  gameId: string,
  error: unknown,
): Promise<never> {
  const reason = error instanceof Error ? error.message : String(error);
  try {
    await prisma.$executeRaw`UPDATE games SET status = 'aborted', ended_at = COALESCE(ended_at, NOW()),
      experiment = jsonb_set(experiment, '{invalid}', ${JSON.stringify({ reason, at: new Date().toISOString() })}::jsonb)
      WHERE id = ${gameId}::uuid AND experiment IS NOT NULL`;
  } catch (persistError) {
    throw new ExperimentInvalidError(`实验已中止，但失效状态写入失败：${reason}`, {
      cause: persistError,
    });
  }
  throw new ExperimentInvalidError(reason, { cause: error });
}
