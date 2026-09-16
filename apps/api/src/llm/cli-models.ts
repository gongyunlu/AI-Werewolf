import { ConfigService } from '@nestjs/config';
import { envSchema, type Env } from '../config/env.validation';
import { LangfuseService } from '../observability/langfuse.service';
import { ModelCallService } from './model-call.service';
import { ModelGenerationService } from './model-generation.service';
import { EmbeddingService } from '../memory/embedding.service';
import { z } from 'zod';

/** CLI 与 API 使用同一调用实现；短进程显式关闭观测导出器。 */
export function createCliModels() {
  const durations = envSchema
    .pick({
      ARK_API_KEY: true,
      ARK_BASE_URL: true,
      ARK_DEFAULT_MODEL: true,
      ARK_EMBEDDING_MODEL: true,
      JUDGE_MODEL: true,
      MODEL_CAPABILITIES: true,
      LLM_CALL_TIMEOUT_MS: true,
      LLM_FIRST_CHUNK_TIMEOUT_MS: true,
      LLM_STREAM_IDLE_TIMEOUT_MS: true,
      LLM_STREAM_MAX_DURATION_MS: true,
      LLM_CIRCUIT_MIN_SAMPLES: true,
      LLM_CIRCUIT_COOLDOWN_MS: true,
      LANGFUSE_HOST: true,
      LANGFUSE_PUBLIC_KEY: true,
      LANGFUSE_SECRET_KEY: true,
    })
    .extend({
      CLI_MAX_DURATION_MS: z.coerce
        .number()
        .int()
        .positive()
        .max(2 ** 31 - 1)
        .default(3_600_000),
    })
    .parse(process.env);
  const config = new ConfigService<Env, true>({ ...process.env, ...durations } as unknown as Env);
  const trace = new LangfuseService(config);
  const calls = new ModelCallService(config);
  const generations = new ModelGenerationService(config, calls, trace);
  const embedding = new EmbeddingService(config, calls);
  const signal = AbortSignal.timeout(durations.CLI_MAX_DURATION_MS);
  return { generations, embedding, signal, close: () => trace.onModuleDestroy() };
}
