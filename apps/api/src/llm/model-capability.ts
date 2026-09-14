/**
 * 各模型的结构化输出能力。这类判断只允许出现在这里：同一模型在不同服务里
 * 走不同协议时，故障现象会互相矛盾，排查成本极高。
 *
 * 表里每一条都来自对目标端点的实打实调用，不是推断。
 */
export type StructuredOutputProtocol = 'jsonSchema' | 'functionCalling' | 'jsonMode';

export interface ModelCapability {
  protocol: StructuredOutputProtocol;
  /** 模型会把 JSON 包进 Markdown 代码围栏，文本解析前需剥掉整段围栏。 */
  allowCodeFence: boolean;
}

const DEFAULT_CAPABILITY: ModelCapability = { protocol: 'jsonSchema', allowCodeFence: false };

/** 精确匹配优先于前缀匹配。 */
const EXACT_CAPABILITIES: Readonly<Record<string, ModelCapability>> = {
  // 接受强制 tool_choice 却不遵守，实测多次把 JSON 直接写进正文；
  // json_object 的输出又总被代码围栏包裹。
  'minimax-m3': { protocol: 'jsonMode', allowCodeFence: true },
  // 官方端点不支持 json_schema，且 thinking mode 会直接拒收强制 tool_choice。
  'deepseek-flash': { protocol: 'jsonMode', allowCodeFence: true },
};

const PREFIX_CAPABILITIES: readonly (readonly [string, ModelCapability])[] = [
  // 不支持 response_format=json_schema；工具通道可靠，但会漏必填字段，仍需本地校验兜住。
  ['glm', { protocol: 'functionCalling', allowCodeFence: false }],
  // 其余 MiniMax 型号未见实测数据，沿用工具通道。
  ['minimax', { protocol: 'functionCalling', allowCodeFence: false }],
  // Kimi 走工具调用会被供应商拒绝，故不在此列，落回默认的 jsonSchema。
];

export function resolveModelCapability(modelName: string): ModelCapability {
  const normalized = modelName.trim().toLowerCase();
  return (
    EXACT_CAPABILITIES[normalized] ??
    PREFIX_CAPABILITIES.find(([prefix]) => normalized.startsWith(prefix))?.[1] ??
    DEFAULT_CAPABILITY
  );
}

/**
 * 接受 `thinking:{type:'disabled'}` 的模型前缀。未列出的模型一律不传该开关：传错时
 * glm 系会直接返回 400 打断整轮发言，而别的厂商可能只是静默忽略，两种都难以察觉。
 *
 * 实测（方舟 plan/v3）：deepseek-v4-pro、deepseek-v4-flash、doubao-seed-2.1-turbo、
 * doubao-seed-evolving、kimi-k3、minimax-m3 接受；glm-5.2 与 glm-5.3 返回 400。
 */
const DISABLE_REASONING_PREFIXES = ['deepseek-v4', 'doubao-seed', 'minimax-m3', 'kimi'] as const;

/**
 * 关闭思维链只用于发言链路：那里思考由独立调用生成，思维链是纯冗余。
 *
 * TODO: 尚未对照验证关闭后发言与思考的质量是否下降。开关本身实测把两段发言生成
 * 从约 200s 压到约 12s，收益明确，但质量影响需要固定同一局势做多组对照才能定论。
 */
export function canDisableReasoning(modelName: string): boolean {
  const normalized = modelName.trim().toLowerCase();
  return DISABLE_REASONING_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
