import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Env } from '../config/env.validation';
import { traceIdentity } from '../observability/action-source';

export const SCORE_NAMES = { quality: 'werewolf.quality', verdict: 'werewolf.verdict' } as const;
export interface ScoreConfigReference {
  id: string;
  name: string;
}
export interface ScoreReference {
  id: string;
  name: string;
  timestamp: string;
}
export interface PlatformScore extends ScoreReference {
  projectId: string;
  value: number | string;
  dataType: string;
  source: string;
  configId?: string | null;
  comment?: string | null;
  metadata?: Record<string, unknown> | null;
  subject?: { kind: string; id: string; traceId?: string } | null;
}
export interface ScoreWrite extends ScoreReference {
  traceId: string;
  observationId: string;
  value: number | string;
  dataType: 'NUMERIC' | 'CATEGORICAL';
  configId: string;
  comment: string;
  metadata: Record<string, unknown>;
}
export interface IngestionEvent {
  id: string;
  type: 'trace-create' | 'span-create' | 'score-create';
  timestamp: string;
  body: Record<string, unknown>;
}

export function scoreReferences(runId: string, eventId: string, timestamp: string) {
  return Object.fromEntries(
    Object.entries(SCORE_NAMES).map(([dimension, name]) => [
      dimension,
      {
        id: traceIdentity('score', runId, eventId, name),
        name,
        timestamp,
      },
    ]),
  ) as Record<keyof typeof SCORE_NAMES, ScoreReference>;
}

type ScoreConfigDefinition =
  | { name: string; dataType: 'NUMERIC'; minValue: number; maxValue: number }
  | { name: string; dataType: 'CATEGORICAL'; categories: Array<{ label: string; value: number }> };

/** 平台回包的 categories 是普通对象，键序不保证；比字面量会把已有配置判成不存在。 */
function sameCategories(
  actual: unknown,
  expected: ReadonlyArray<{ label: string; value: number }>,
): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((item) =>
      (actual as Array<{ label: string; value: number }>).some(
        (candidate) => candidate.label === item.label && candidate.value === item.value,
      ),
    )
  );
}

/** 成功回包仅表示接收；采用前还必须按完整身份回读 Scores v3。 */
@Injectable()
export class LangfuseScoresService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const publicKey = this.config.get('LANGFUSE_PUBLIC_KEY');
    const secretKey = this.config.get('LANGFUSE_SECRET_KEY');
    if (!publicKey || !secretKey)
      throw new Error('评分需要 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY；游戏事实不受影响');
    const response = await fetch(this.config.get('LANGFUSE_HOST').replace(/\/$/, '') + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(publicKey + ':' + secretKey).toString('base64'),
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Langfuse ${path.split('?')[0]} 返回 ${response.status}`);
    return response.json() as Promise<T>;
  }

  async project(): Promise<{ id: string; name: string }> {
    const result = await this.request<{ data: Array<{ id: string; name: string }> }>(
      '/api/public/projects',
    );
    if (result.data.length !== 1) throw new Error('评分必须绑定唯一 Langfuse 项目');
    return result.data[0];
  }

  async configurations(): Promise<Record<keyof typeof SCORE_NAMES, ScoreConfigReference>> {
    const expected: ScoreConfigDefinition[] = [
      { name: SCORE_NAMES.quality, dataType: 'NUMERIC', minValue: 0, maxValue: 100 },
      {
        name: SCORE_NAMES.verdict,
        dataType: 'CATEGORICAL',
        categories: [
          { label: 'poor', value: 0 },
          { label: 'fair', value: 1 },
          { label: 'good', value: 2 },
        ],
      },
    ];
    const all: Array<Record<string, unknown> & { id: string; name: string }> = [];
    for (let page = 1; ; page++) {
      const result = await this.request<{ data: typeof all; meta: { totalPages: number } }>(
        `/api/public/score-configs?page=${page}&limit=100`,
      );
      all.push(...result.data);
      if (page >= result.meta.totalPages) break;
    }
    const refs: ScoreConfigReference[] = [];
    for (const definition of expected) {
      const match = all
        .filter((entry) => entry.name === definition.name && !entry.isArchived)
        .find(
          (entry) =>
            entry.dataType === definition.dataType &&
            (definition.dataType === 'NUMERIC'
              ? entry.minValue === 0 && entry.maxValue === 100
              : sameCategories(entry.categories, definition.categories)),
        );
      const config =
        match ??
        (await this.request<ScoreConfigReference>('/api/public/score-configs', {
          ...definition,
          description: '狼人杀领域判分：原初判与一次反思修正的最终结果；业务仅采用明确完整批次。',
        }));
      refs.push({ id: config.id, name: config.name });
    }
    return { quality: refs[0], verdict: refs[1] };
  }

  async ingest(events: IngestionEvent[]): Promise<void> {
    const environment =
      this.config.get('NODE_ENV') === 'test' ? 'werewolf-integration-test' : undefined;
    const result = await this.request<{ errors?: unknown[] }>('/api/public/ingestion', {
      batch: events.map((event) => ({
        ...event,
        body: { ...event.body, ...(environment ? { environment } : {}) },
      })),
    });
    if (result.errors?.length) throw new Error(`Langfuse 拒绝 ${result.errors.length} 项交付`);
  }

  async writeScores(scores: ScoreWrite[], observations: IngestionEvent[]): Promise<void> {
    await this.ingest([
      ...observations,
      ...scores.map(({ timestamp, ...body }) => ({
        // 外层 ingestion ID 标记交付请求；Score 的 ID/name/原始日期才是平台结果身份。
        id: randomUUID(),
        type: 'score-create' as const,
        timestamp,
        body,
      })),
    ]);
  }

  /** 每次按一批 ID 查询，不在在线玩家行动中请求平台；兼容异步可见和游标分页。 */
  async readScores(ids: string[]): Promise<PlatformScore[]> {
    const scores: PlatformScore[] = [];
    for (let offset = 0; offset < ids.length; offset += 40) {
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({
          id: ids.slice(offset, offset + 40).join(','),
          limit: '100',
          fields: 'details,subject,annotation',
        });
        if (cursor) query.set('cursor', cursor);
        const result = await this.request<{ data: PlatformScore[]; meta: { cursor?: string } }>(
          '/api/public/v3/scores?' + query,
        );
        scores.push(...result.data);
        cursor = result.meta.cursor;
      } while (cursor);
    }
    return scores;
  }
}

export function selectScore(
  scores: PlatformScore[],
  reference: ScoreReference,
): PlatformScore | undefined {
  const matching = scores.filter(
    (score) =>
      score.id === reference.id &&
      score.name === reference.name &&
      score.timestamp.slice(0, 10) === reference.timestamp.slice(0, 10),
  );
  if (matching.length > 1) throw new Error('平台评分身份不唯一，拒绝自动采用');
  return matching[0];
}
