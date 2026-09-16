import { AgentRuntimeService } from '../agent-runtime/agent-runtime.service';
import { ModelCallService } from '../llm/model-call.service';
import { ModelGenerationService } from '../llm/model-generation.service';
import { testModelCapabilities } from './model-capabilities.fixture';
import { PlayerTurnService } from '../player-turn/player-turn.service';
import type { LangfuseService } from '../observability/langfuse.service';

type Dependencies = ConstructorParameters<typeof AgentRuntimeService>;
/** 测试使用真实模型/回合实现，只替换存储和网络；与 Nest 使用同一构造关系。 */
export function createAgentRuntime(
  ...dependencies: [
    Dependencies[0],
    Dependencies[1],
    Dependencies[2],
    Dependencies[3],
    Dependencies[4],
    Dependencies[5],
    Dependencies[6],
    LangfuseService,
    Dependencies[7],
    Dependencies[10]?,
  ]
): AgentRuntimeService {
  const [
    config,
    prisma,
    memory,
    globalMemory,
    knowledge,
    skills,
    summary,
    langfuse,
    prompts,
    recovery,
  ] = dependencies;
  const modelConfig = {
    get: (key: string) =>
      key === 'MODEL_CAPABILITIES'
        ? (config.get('MODEL_CAPABILITIES') ??
          testModelCapabilities(config.get('ARK_BASE_URL') ?? 'https://provider.test/v3', [
            ...Array.from({ length: 18 }, (_, i) => `mock-seat-${i + 1}`),
            'test-model',
            'test',
            'model',
            'm',
            'glm-5.2',
            'glm-5.3',
            'glm-4-plus',
            'glm-4.5',
            'minimax-m3',
            'minimax-v2',
            'deepseek-flash',
            'deepseek',
            'deepseek-v4-pro',
            'deepseek-v4-flash',
            'doubao-seed-2.1-turbo',
            'doubao-seed-evolving',
            'kimi-k3',
            'doubao-pro',
          ]))
        : key === 'ARK_BASE_URL'
          ? (config.get('ARK_BASE_URL') ?? 'https://provider.test/v3')
          : config.get(key as never),
  } as typeof config;
  const modelCalls = new ModelCallService(modelConfig);
  const generations = new ModelGenerationService(modelConfig, modelCalls, langfuse, recovery);
  const turns = new PlayerTurnService(config, generations, prompts, langfuse);
  return new AgentRuntimeService(
    config,
    prisma,
    memory,
    globalMemory,
    knowledge,
    skills,
    summary,
    prompts,
    generations,
    turns,
    recovery,
  );
}
