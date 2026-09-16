import { z } from 'zod';

export type StructuredOutputProtocol = 'jsonSchema' | 'functionCalling' | 'jsonMode';
export interface ModelCapability {
  protocol: StructuredOutputProtocol;
  allowCodeFence: boolean;
  disableReasoning: boolean;
}
const declaration = z.array(
  z.object({
    baseUrl: z.url(),
    model: z.string().min(1),
    protocol: z.enum(['jsonSchema', 'functionCalling', 'jsonMode']),
    allowCodeFence: z.boolean(),
    disableReasoning: z.boolean(),
  }),
);

// 仅覆盖已经使用过的方舟接入与精确型号，不把能力推断扩散到同名前缀或其他网关。
const arkModels: Record<string, ModelCapability> = Object.fromEntries(
  [
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'doubao-seed-2.1-turbo',
    'doubao-seed-evolving',
    'kimi-k3',
  ].map((model) => [
    model,
    { protocol: 'jsonSchema', allowCodeFence: false, disableReasoning: true },
  ]),
);
arkModels['glm-5.2'] = arkModels['glm-5.3'] = {
  protocol: 'functionCalling',
  allowCodeFence: false,
  disableReasoning: false,
};
arkModels['minimax-m3'] = { protocol: 'jsonMode', allowCodeFence: true, disableReasoning: true };

export function resolveModelCapability(
  modelName: string,
  baseUrl: string,
  declarations?: string,
): ModelCapability {
  const endpoint = new URL(baseUrl).href.replace(/\/$/, '');
  const entries = declarations ? declaration.parse(JSON.parse(declarations)) : [];
  const matches = entries.filter(
    (entry) =>
      new URL(entry.baseUrl).href.replace(/\/$/, '') === endpoint && entry.model === modelName,
  );
  if (matches.length > 1) throw new Error('模型能力声明重复');
  const matched = matches[0];
  if (matched)
    return {
      protocol: matched.protocol,
      allowCodeFence: matched.allowCodeFence,
      disableReasoning: matched.disableReasoning,
    };
  const known =
    endpoint === 'https://ark.cn-beijing.volces.com/api/plan/v3' ? arkModels[modelName] : undefined;
  if (!known) throw new Error(`未声明该端点与模型的能力：${endpoint} / ${modelName}`);
  return known;
}

export function structuredProtocol(protocol: ModelCapability['protocol']): string {
  return protocol === 'functionCalling'
    ? '本次结果必须调用 extract 工具提交，将完整 JSON 对象作为工具参数并填写 Schema 中所有必需字段。普通正文或 Markdown 代码块不能代替工具调用。'
    : '请严格按本次给定的 JSON Schema 返回完整对象。';
}
