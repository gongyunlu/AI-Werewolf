import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIEmbeddings } from '@langchain/openai';
import type { Env } from '../config/env.validation';

export const MEMORY_EMBEDDING_DIMENSION = 2048;

/**
 * Embedding 服务：封装火山方舟向量化模型，为 Memory 生成语义向量。
 *
 * 模型 doubao-embedding-vision 输出 2048 维，走 ARK_BASE_URL 的 OpenAI 兼容 /embeddings 端点。
 */
@Injectable()
export class EmbeddingService {
  private readonly embeddings: OpenAIEmbeddings;
  readonly model: string;
  readonly dimension = MEMORY_EMBEDDING_DIMENSION;

  constructor(private readonly configService: ConfigService<Env, true>) {
    this.model = this.configService.get('ARK_EMBEDDING_MODEL');
    this.embeddings = new OpenAIEmbeddings({
      apiKey: this.configService.get('ARK_API_KEY'),
      model: this.model,
      configuration: { baseURL: this.configService.get('ARK_BASE_URL') },
    });
  }

  /** 单条文本 → 向量 */
  async embedText(text: string): Promise<number[]> {
    const vector = await this.embeddings.embedQuery(text);
    this.assertValidVector(vector);
    return vector;
  }

  /** 批量文本 → 向量数组。火山方舟 embedding API 单次请求上限 10 条，超过需分批。 */
  async embedTexts(texts: string[]): Promise<number[][]> {
    const batchSize = 10;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const vectors = await this.embeddings.embedDocuments(batch);
      if (vectors.length !== batch.length) {
        throw new Error(
          `Embedding 服务返回数量异常：期望 ${batch.length} 条，实际 ${vectors.length} 条`,
        );
      }
      vectors.forEach((vector) => this.assertValidVector(vector));
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
