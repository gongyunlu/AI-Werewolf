import { ConfigService } from '@nestjs/config';
import { ModelCallService } from '../../src/llm/model-call.service';
import { ModelGenerationService } from '../../src/llm/model-generation.service';
import { LangfuseService } from '../../src/observability/langfuse.service';
import type { GameRecoveryService } from '../../src/game-recovery/game-recovery.service';
import type { Env } from '../../src/config/env.validation';
import { testModelCapabilities } from '../../src/testing/model-capabilities.fixture';

export function stageModels(baseUrl: string, recovery?: GameRecoveryService) {
  const config = new ConfigService<Env, true>({
    ARK_BASE_URL: baseUrl,
    ARK_API_KEY: 'test-key',
    ARK_DEFAULT_MODEL: 'script',
    LANGFUSE_PUBLIC_KEY: '',
    LANGFUSE_SECRET_KEY: '',
    MODEL_CAPABILITIES: testModelCapabilities(baseUrl, ['script']),
    LLM_CIRCUIT_MIN_SAMPLES: 100,
    LLM_STREAM_MAX_DURATION_MS: 30_000,
    LLM_FIRST_CHUNK_TIMEOUT_MS: 5000,
    LLM_STREAM_IDLE_TIMEOUT_MS: 5000,
  } as Env);
  const calls = new ModelCallService(config);
  const traces = new LangfuseService(config);
  return {
    config,
    calls,
    generations: new ModelGenerationService(config, calls, traces, recovery),
    traces,
  };
}
