import { createHash } from 'node:crypto';
import type { Event, Prisma } from '@/generated/prisma/client';
import type { ActionSource } from '@/observability/action-source';
import type { ExecutionIdentity } from '@/game-recovery/execution-fence';

export interface SubmissionScope {
  gameId: string;
  phaseInstanceId: string;
  signal?: AbortSignal;
  source?: ActionSource;
  sources?: Record<string, ActionSource | undefined>;
  /** 由调用方给出的执行权归属；给出时提交先校验执行权再写入。 */
  execution?: ExecutionIdentity;
}

export type CommittedEvent = Event & { replayed: boolean };

export class SubmissionConflictError extends Error {
  constructor(key: string) {
    super(`领域提交内容冲突：${key}`);
    this.name = 'SubmissionConflictError';
  }
}

/** 对象顺序无语义；数组默认有序，集合由领域入口明确排序。 */
export function normalizeSubmission(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map((item) => normalizeSubmission(item));
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .toSorted()
        .filter((key) => source[key] !== undefined)
        .map((key) => [key, normalizeSubmission(source[key])]),
    );
  }
  throw new Error('提交内容必须是完整的 JSON，不能包含非有限数、未定义数组项或特殊对象');
}

export function submissionHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeSubmission(value)))
    .digest('hex');
}

export function submissionKey(scope: SubmissionScope, slot: string, actor = 'system', ordinal = 0) {
  if (!scope.gameId || !/^node\/\d+\/[A-Za-z]\w*$/.test(scope.phaseInstanceId))
    throw new Error('领域提交缺少有效的节点实例标识');
  // JSON 元组避免各组成部分中的分隔符造成不同业务动作碰撞。
  return JSON.stringify([scope.gameId, scope.phaseInstanceId, slot, actor, ordinal]);
}

export function sortedUnique(values: string[], label: string): string[] {
  if (
    values.some((value) => typeof value !== 'string' || !value) ||
    new Set(values).size !== values.length
  )
    throw new Error(`${label}包含空值或重复成员`);
  return values.toSorted();
}
