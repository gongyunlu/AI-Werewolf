import { Injectable, Optional, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIClient } from '@langchain/openai';
import { ModelCallService } from '../llm/model-call.service';
import { GameRecoveryService } from '../game-recovery/game-recovery.service';
import type { Env } from '../config/env.validation';

export const MEMORY_EMBEDDING_DIMENSION = 2048;

/**
 * Embedding 服务：封装火山方舟向量化模型，为 Memory 生成语义向量。
 *
 * 模型 doubao-embedding-vision 输出 2048 维，走 ARK_BASE_URL 的 OpenAI 兼容 /embeddings 端点。
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly client: OpenAIClient;
  readonly model: string;
  readonly dimension = MEMORY_EMBEDDING_DIMENSION;

  constructor(
    private readonly configService: ConfigService<Env, true>,
    @Optional() private readonly calls: ModelCallService = new ModelCallService(configService),
    @Optional() private readonly recovery?: GameRecoveryService,
  ) {
    this.model = this.configService.get('ARK_EMBEDDING_MODEL');
    this.client = new OpenAIClient({
      apiKey: this.configService.get('ARK_API_KEY'),
      baseURL: this.configService.get('ARK_BASE_URL'),
      maxRetries: 0,
      timeout: this.configService.get('LLM_CALL_TIMEOUT_MS') ?? 300_000,
    });
  }

  /** 单条文本 → 向量 */
  async embedText(text: string, signal?: AbortSignal): Promise<number[]> {
    return (await this.embedTexts([text], signal))[0];
  }

  /** 批量文本 → 向量数组。火山方舟 embedding API 单次请求上限 10 条，超过需分批。 */
  async embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    signal = AbortSignal.any(
      [signal, this.recovery?.current?.signal].filter((value): value is AbortSignal => !!value),
    );
    const batchSize = 10;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      signal?.throwIfAborted();
      const startedAt = Date.now();
      const response = await this.calls.run(
        this.model,
        (callSignal) =>
          this.client.embeddings.create(
            { model: this.model, input: batch, encoding_format: 'float' },
            { signal: callSignal },
          ),
        signal,
        { runName: 'embedding', batchSize: batch.length },
      );
      const vectors = response.data
        .toSorted((a, b) => a.index - b.index)
        .map((row, index) => {
          if (row.index !== index) throw new Error('Embedding 返回索引重复或缺失');
          return row.embedding;
        });
      if (vectors.length !== batch.length) {
        throw new Error(
          `Embedding 服务返回数量异常：期望 ${batch.length} 条，实际 ${vectors.length} 条`,
        );
      }
      vectors.forEach((vector) => this.assertValidVector(vector));
      this.logger.debug(
        {
          modelName: this.model,
          batchSize: batch.length,
          dimension: this.dimension,
          inputTokens: response.usage?.prompt_tokens,
          elapsedMs: Date.now() - startedAt,
        },
        '向量请求完成',
      );
      out.push(...vectors);
    }
    return out;
  }

  /**
   * 校验向量与数据库 vector(2048) 列的契约一致。
   * 此方法也供写库路径调用，防止绕过模型生成流程写入非法向量。
   */
  assertValidVector(vector: unknown): asserts vector is number[] {
    if (!Array.isArray(vector)) {
      throw new Error('Embedding 向量格式无效：期望数字数组');
    }
    if (vector.length !== MEMORY_EMBEDDING_DIMENSION) {
      throw new Error(
        `Embedding 向量维度无效：期望 ${MEMORY_EMBEDDING_DIMENSION} 维，实际 ${vector.length} 维`,
      );
    }

    const invalidIndex = vector.findIndex(
      (value) => typeof value !== 'number' || !Number.isFinite(value),
    );
    if (invalidIndex !== -1) {
      throw new Error(`Embedding 向量数值无效：索引 ${invalidIndex} 不是有限数值`);
    }
  }
}
