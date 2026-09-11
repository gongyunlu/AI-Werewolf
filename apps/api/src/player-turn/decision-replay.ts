import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { FrozenPrompts } from '../evaluation/experiment-snapshot';
import type { PlayerTurnService, TurnGenerationContext } from './player-turn.service';

export interface DecisionReplaySnapshot {
  decisionMode?: 'joint';
  systemPrompt: string;
  modelName: string;
  role: string;
  scenario: string;
  schema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  prompts: FrozenPrompts;
  reflectionMaxRounds?: number;
  evidence: Array<{ sequence: number }>;
  reasoningHistory?: Array<{ type: string; content: BaseMessage['content'] }>;
}

/** 当前动作契约是浅层对象：沿用在线 z.object 的剔除额外字段及字符串枚举语义。 */
function restoreDecisionSchema(definition: Record<string, unknown>): z.ZodObject {
  // z.number().int() 本身已有安全整数范围；转换器会把导出的同一范围再添加一次。
  const parserDefinition = JSON.parse(
    JSON.stringify(definition, (_key, value) => {
      if (value?.type !== 'integer') return value;
      const field = { ...value };
      if (field.minimum === Number.MIN_SAFE_INTEGER) delete field.minimum;
      if (field.maximum === Number.MAX_SAFE_INTEGER) delete field.maximum;
      return field;
    }),
  );
  const restored = z.fromJSONSchema(parserDefinition);
  if (!(restored instanceof z.ZodObject)) throw new Error('当前重放只支持对象形式的动作契约');
  const shape = { ...restored.shape };
  const properties = definition.properties as Record<
    string,
    { enum?: unknown[]; description?: string }
  >;
  const required = definition.required as string[];
  for (const [name, property] of Object.entries(properties)) {
    // Zod 的 JSON 转换器把单值 enum 变为 literal，会连带改变纠错消息。
    if (property.enum?.every((value) => typeof value === 'string')) {
      let field: z.ZodType = z.enum(property.enum as string[]);
      if (!required.includes(name)) field = field.optional();
      if (property.description) field = field.describe(property.description);
      shape[name] = field;
    }
  }
  return z.object(shape);
}

/** 重放只生成候选和审查记录，不读取新局面、保存历史或提交行动。 */
export async function replayDecision(
  turns: PlayerTurnService,
  snapshot: DecisionReplaySnapshot,
  identity: { gameId: string; playerId: string },
  signal?: AbortSignal,
) {
  if (snapshot.decisionMode !== 'joint')
    throw new Error('此历史快照不是当前联合决策协议，不能作为在线回合重放');
  if (
    !Number.isInteger(snapshot.reflectionMaxRounds) ||
    snapshot.reflectionMaxRounds! < 0 ||
    snapshot.reflectionMaxRounds! > 10
  )
    throw new Error('快照缺少明确的反思轮次；历史诊断需显式提供轮次并标记配置来源');
  const history = (snapshot.reasoningHistory ?? []).map((message) => {
    if (message.type === 'ai') return new AIMessage(message.content);
    if (message.type === 'human') return new HumanMessage(message.content);
    throw new Error(`快照包含不支持的历史消息角色: ${message.type}`);
  });
  const context: TurnGenerationContext = {
    systemPrompt: snapshot.systemPrompt,
    player: {
      id: identity.playerId,
      gameId: identity.gameId,
      modelName: snapshot.modelName,
      role: snapshot.role,
    },
    scenario: snapshot.scenario,
    prompts: snapshot.prompts,
    reflectionMaxRounds: snapshot.reflectionMaxRounds,
    replay: { evidence: snapshot.evidence },
  };
  const result = await turns.decide(
    context,
    restoreDecisionSchema(snapshot.schema),
    history,
    signal,
    snapshot.outputSchema,
  );
  return { ...result, reflection: context.replay!.reflection };
}
