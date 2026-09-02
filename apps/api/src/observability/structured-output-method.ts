/**
 * 火山方舟兼容 OpenAI 接口时，不同模型支持的结构化输出方式并不一致。
 * GLM 不支持 response_format=json_schema，只能走工具调用；minimax-m3 同样忽略
 * response_format（输出被 markdown 包裹或纯文本），实测支持工具调用；
 * Kimi 等模型则应继续使用 jsonSchema，避免 functionCalling 请求被供应商拒绝。
 */
const FUNCTION_CALLING_MODEL_PREFIXES = ['glm', 'minimax'] as const;

export type StructuredOutputMethod = 'functionCalling' | 'jsonSchema';

export function resolveStructuredOutputMethod(modelName: string): StructuredOutputMethod {
  const normalized = modelName.trim().toLowerCase();
  return FUNCTION_CALLING_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    ? 'functionCalling'
    : 'jsonSchema';
}
