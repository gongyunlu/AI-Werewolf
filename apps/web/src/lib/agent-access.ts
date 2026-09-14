import type { Agent, AgentUpdateInput } from './api-client';

export interface AccessFormInput {
  /** 输入框里的接入端点；空串表示要清空 */
  baseUrl: string;
  /** 输入框里的新密钥；空串表示不改动 */
  apiKey: string;
}

/**
 * 把表单输入折算成 PATCH 的接入字段。
 *
 * 后端要求端点与密钥成对存在：缺省表示保持原值，null 表示清除。
 * 这里挡掉几种前端能提前发现的不一致，避免整表提交后才被后端拒绝。
 *
 * @throws Error 输入组合不成立时抛出，消息可直接展示给使用者
 */
export function buildAccessPatch(agent: Agent, input: AccessFormInput): AgentUpdateInput {
  const baseUrl = input.baseUrl.trim();
  const apiKey = input.apiKey.trim();

  if (!baseUrl) {
    if (apiKey) throw new Error('清空接入端点时不需要填写新密钥');
    // 本来就没有自带接入时不必提交字段，避免无意义地写空值
    return agent.baseUrl === null ? {} : { baseUrl: null, apiKey: null };
  }

  if (baseUrl === agent.baseUrl) {
    if (!apiKey) return {};
    return { apiKey };
  }

  // 端点变了：已有密钥时后端会沿用旧密钥，没有密钥就只能一起给出
  if (!apiKey && !agent.hasApiKey) throw new Error('首次配置接入端点时必须同时填写密钥');
  return apiKey ? { baseUrl, apiKey } : { baseUrl };
}
