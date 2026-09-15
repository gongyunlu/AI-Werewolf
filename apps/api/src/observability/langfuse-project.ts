import type { Langfuse } from 'langfuse-langchain';

/** 项目身份不包含密钥；同项目换钥不改变冻结 Prompt 的来源。 */
export interface PromptOrigin {
  baseUrl: string;
  projectId: string;
}

export async function readPromptOrigin(
  client: Langfuse,
  baseUrl: string,
): Promise<PromptOrigin | undefined> {
  try {
    const { data } = await client.api.projectsGet({ signal: AbortSignal.timeout(5000) });
    if (data.length === 1 && data[0].id)
      return { baseUrl: baseUrl.replace(/\/+$/, ''), projectId: data[0].id };
  } catch {
    // 无法确认项目时只省略原生版本关联，不能阻断模型调用或改写冻结正文。
  }
  return undefined;
}
