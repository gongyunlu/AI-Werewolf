import { HumanMessage } from '@langchain/core/messages';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { LangfuseService } from '../src/observability/langfuse.service';
import { PromptService } from '../src/observability/prompt.service';
import { PROMPT_NAMES } from '../src/observability/prompt-templates';
import { ModelCallService } from '../src/llm/model-call.service';
import type { Env } from '../src/config/env.validation';

// 使用真实 Langfuse/LangChain SDK 和生产流式调用；HTTP 桩隔离项目与免费模型响应。
it.each([
  ['同项目新密钥', 'project-a', 'https://trace.invalid/', true],
  ['跨项目恢复', 'project-b', 'https://trace.invalid', false],
  ['同 ID 不同服务', 'project-a', 'https://other.invalid', false],
  ['身份查询失败', undefined, 'https://trace.invalid', false],
] as const)('真实 SDK 的冻结 Prompt 关联：%s', async (_case, currentProject, host, linked) => {
  const name = PROMPT_NAMES.agentSpeechContent;
  const batches: Array<{ type: string; body: Record<string, unknown> }> = [];
  const modelInputs: string[] = [];
  const promptReads: string[] = [];
  const projectReads: string[] = [];
  const response = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const intercepted = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const isOriginal = auth === 'Basic ' + Buffer.from('key-a:secret-a').toString('base64');
    if (url.pathname === '/api/public/projects') {
      projectReads.push(auth);
      return isOriginal
        ? response({ data: [{ id: 'project-a', name: '合成项目 A' }] })
        : currentProject
          ? response({ data: [{ id: currentProject, name: '合成恢复项目' }] })
          : response({ message: '合成项目查询失败' }, 503);
    }
    if (url.pathname.startsWith('/api/public/v2/prompts/')) {
      promptReads.push(auth);
      return response({
        id: 'prompt-a',
        name,
        type: 'text',
        version: 1,
        prompt: '项目 A 的冻结正文 {{thinking}}',
        config: {},
        labels: ['production'],
        tags: [],
      });
    }
    if (url.pathname === '/api/public/ingestion') {
      batches.push(...JSON.parse(String(init?.body)).batch);
      return response({ successes: [], errors: [] });
    }
    if (url.hostname === 'model.invalid') {
      modelInputs.push(JSON.stringify(JSON.parse(String(init?.body)).messages));
      const chunks = [
        {
          choices: [
            { index: 0, delta: { role: 'assistant', content: '合成输出' }, finish_reason: null },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]
        .map((chunk) => 'data: ' + JSON.stringify(chunk) + '\n\n')
        .join('');
      return new Response(chunks + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    throw new Error('未声明的合成 HTTP 路径：' + url.pathname);
  });
  const config = (baseUrl: string, rotated = false) =>
    new ConfigService<Env, true>({
      LANGFUSE_HOST: baseUrl,
      LANGFUSE_PUBLIC_KEY: rotated ? 'rotated-key' : 'key-a',
      LANGFUSE_SECRET_KEY: rotated ? 'rotated-secret' : 'secret-a',
      ARK_BASE_URL: 'https://model.invalid/v1',
      ARK_API_KEY: 'synthetic-model-key',
      NODE_ENV: 'test',
    });
  const traces = new LangfuseService(config(host, true));
  try {
    const original = new PromptService(config('https://trace.invalid'));
    const snapshot = JSON.parse(JSON.stringify(await original.captureSnapshot([name])));
    expect(snapshot[name].origin).toEqual({
      baseUrl: 'https://trace.invalid',
      projectId: 'project-a',
    });
    const restored = new PromptService(config(host, true));
    await traces.onModuleInit();
    const models = new ModelCallService(config(host, true));
    for (const variant of ['frozen', 'legacy', 'local_release', 'local_default']) {
      const frozen = structuredClone(snapshot);
      if (variant === 'legacy') delete frozen[name].origin;
      if (variant.startsWith('local_')) frozen[name].source = variant;
      const prompt = await restored.render(name, { thinking: '唯一合成输入' }, frozen);
      const trace = traces.trace({
        runName: variant,
        gameId: randomUUID(),
        playerId: 'synthetic',
        modelName: 'glm-4',
        promptName: prompt.name,
        promptVersion: prompt.version,
        promptSource: prompt.source,
        promptOrigin: prompt.origin,
      });
      expect(
        await models.streamText(
          'glm-4',
          [new HumanMessage(prompt.text)],
          undefined,
          undefined,
          trace,
        ),
      ).toBe('合成输出');
    }
    await traces.onModuleDestroy();
    const generations = batches.filter((entry) => entry.type === 'generation-create');
    expect(generations).toHaveLength(4);
    for (const [index, entry] of generations.entries()) {
      expect(entry.body.promptName).toBe(linked && index === 0 ? name : undefined);
      expect(entry.body.promptVersion).toBe(linked && index === 0 ? 1 : undefined);
    }
    expect(modelInputs).toHaveLength(4);
    for (const input of modelInputs) expect(input).toContain('项目 A 的冻结正文 唯一合成输入');
    expect(promptReads).toHaveLength(1);
    expect(new Set(projectReads).size).toBe(2);
    expect(JSON.stringify(batches)).not.toContain('rotated-secret');
    expect(JSON.stringify(snapshot)).not.toContain('secret-a');
  } finally {
    await traces.onModuleDestroy();
    intercepted.mockRestore();
  }
});
