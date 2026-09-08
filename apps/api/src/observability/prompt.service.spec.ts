import { ConfigService } from '@nestjs/config';
import { Langfuse } from 'langfuse-langchain';
import type { Env } from '../config/env.validation';
import {
  FALLBACK_TEMPLATES,
  PROMPT_NAMES,
  REQUIRED_PROMPT_VARIABLES,
  renderTemplate,
} from './prompt-templates';
import { PromptService } from './prompt.service';

function createConfig(enabled = true): ConfigService<Env, true> {
  const values: Partial<Record<keyof Env, string>> = enabled
    ? {
        LANGFUSE_PUBLIC_KEY: 'public-key',
        LANGFUSE_SECRET_KEY: 'secret-key',
        LANGFUSE_HOST: 'https://langfuse.example.com',
      }
    : {};

  return {
    get: jest.fn((key: keyof Env) => values[key]),
  } as unknown as ConfigService<Env, true>;
}

describe('PromptService', () => {
  it('线上及冻结模板接受空格占位符，输入中的美元和嵌套占位符保持原文', async () => {
    const name = PROMPT_NAMES.agentDecisionUser;
    const template = FALLBACK_TEMPLATES[name].replace(/\{\{(\w+)\}\}/g, '{{ $1 }}');
    jest
      .spyOn(Langfuse.prototype, 'getPrompt')
      .mockResolvedValueOnce({ prompt: template, version: 9 } as never);
    const service = new PromptService(createConfig());
    const variables = { reasoning: '输入 $& {{ untouched }}' };
    const online = await service.render(name, variables);
    const frozen = await service.render(name, variables, {
      [name]: { text: template, version: 9 },
    });
    expect(online).toEqual(frozen);
    expect(online.version).toBe(9);
    expect(online.text).toContain(variables.reasoning);
    expect(online.text).not.toContain('{{ reasoning }}');
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('production prompt 满足变量契约时使用线上版本', async () => {
    const compile = jest.fn().mockReturnValue('online rendered prompt');
    jest.spyOn(Langfuse.prototype, 'getPrompt').mockResolvedValueOnce({
      prompt: FALLBACK_TEMPLATES[PROMPT_NAMES.agentSpeechContent],
      version: 7,
      compile,
    } as never);
    const service = new PromptService(createConfig());

    const result = await service.render(PROMPT_NAMES.agentSpeechContent, { thinking: '推理' });

    expect(result).toEqual({
      text: renderTemplate(FALLBACK_TEMPLATES[PROMPT_NAMES.agentSpeechContent], {
        thinking: '推理',
      }),
      name: PROMPT_NAMES.agentSpeechContent,
      version: 7,
    });
    expect(compile).not.toHaveBeenCalled();
  });

  it('production prompt 缺少 experience 时回退本地模板，不静默丢弃经验', async () => {
    const stalePrompt = FALLBACK_TEMPLATES[PROMPT_NAMES.agentSystemPrompt].replace(
      '{{experience}}',
      '',
    );
    const compile = jest.fn().mockReturnValue('stale online prompt');
    jest.spyOn(Langfuse.prototype, 'getPrompt').mockResolvedValueOnce({
      prompt: stalePrompt,
      version: 3,
      compile,
    } as never);
    const service = new PromptService(createConfig());

    const result = await service.render(PROMPT_NAMES.agentSystemPrompt, {
      experience: '同类场景下优先核验票型',
    });

    expect(REQUIRED_PROMPT_VARIABLES[PROMPT_NAMES.agentSystemPrompt]).toContain('experience');
    expect(result.version).toBeNull();
    expect(result.text).toContain('同类场景下优先核验票型');
    expect(compile).not.toHaveBeenCalled();
  });

  it('LangFuse 拉取失败时沿用本地 fallback', async () => {
    jest.spyOn(Langfuse.prototype, 'getPrompt').mockRejectedValueOnce(new Error('offline'));
    const service = new PromptService(createConfig());

    const result = await service.render(PROMPT_NAMES.agentDecisionUser, { reasoning: '投给3号' });

    expect(result.version).toBeNull();
    expect(result.text).toContain('投给3号');
  });

  it('未配置 LangFuse 时直接使用本地 fallback', async () => {
    const getPrompt = jest.spyOn(Langfuse.prototype, 'getPrompt');
    const service = new PromptService(createConfig(false));

    const result = await service.render(PROMPT_NAMES.wolfCoordination, { discussion: '刀3号' });

    expect(result.version).toBeNull();
    expect(result.text).toContain('刀3号');
    expect(getPrompt).not.toHaveBeenCalled();
  });
});
