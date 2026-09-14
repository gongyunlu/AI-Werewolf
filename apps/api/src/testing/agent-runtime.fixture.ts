import { AgentRuntimeService } from '../agent-runtime/agent-runtime.service';
import { ModelCallService } from '../llm/model-call.service';
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
  const modelCalls = new ModelCallService(config);
  const turns = new PlayerTurnService(config, modelCalls, prompts, langfuse);
  return new AgentRuntimeService(
    config,
    prisma,
    memory,
    globalMemory,
    knowledge,
    skills,
    summary,
    prompts,
    modelCalls,
    turns,
    recovery,
  );
}
