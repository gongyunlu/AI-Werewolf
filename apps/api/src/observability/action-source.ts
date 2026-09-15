import { createHash, randomUUID } from 'node:crypto';

/** 只保存采用产物的引用；调用内容和各次失败由 Langfuse 管理。 */
export interface ActionSource {
  actionKey: string;
  traceId: string;
  attemptId: string;
  startedAt: string;
  outputObservationId?: string;
}

export function traceIdentity(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

export function createActionSource(actionKey: string): ActionSource {
  return {
    actionKey,
    traceId: traceIdentity('action', actionKey),
    attemptId: randomUUID(),
    startedAt: new Date().toISOString(),
  };
}
