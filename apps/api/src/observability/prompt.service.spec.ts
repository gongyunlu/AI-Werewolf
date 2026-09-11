import turnRelease from './turn-prompt-release.json';
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

it('本地发布副本不满足新契约时使用当前模板，不沿用旧版本号', async () => {
  const name = PROMPT_NAMES.agentTurnReflect;
  const released = turnRelease.prompts[name];
  const original = released.text;
  released.text = '旧副本只有 {{candidate}}';
  try {
    const result = await new PromptService(createConfig(false)).render(name);
    expect(result).toMatchObject({
      text: FALLBACK_TEMPLATES[name],
      version: null,
      source: 'local_default',
    });
  } finally {
    released.text = original;
  }
});

describe('PromptService', () => {
  it('线上及冻结模板接受空格占位符，输入中的美元和嵌套占位符保持原文', async () => {
    const name = PROMPT_NAMES.agentSpeechContent;
    const template = FALLBACK_TEMPLATES[name].replace(/\{\{(\w+)\}\}/g, '{{ $1 }}');
    jest
      .spyOn(Langfuse.prototype, 'getPrompt')
      .mockResolvedValueOnce({ prompt: template, version: 9 } as never);
    const service = new PromptService(createConfig());
    const variables = { thinking: '输入 $& {{ untouched }}' };
    const online = await service.render(name, variables);
    const frozen = await service.render(name, variables, {
      [name]: { text: template, version: 9 },
    });
    expect(online).toEqual({ ...frozen, source: 'langfuse' });
    expect(online.version).toBe(9);
    expect(online.text).toContain(variables.thinking);
    expect(online.text).not.toContain('{{ thinking }}');
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
      source: 'langfuse',
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
    expect(result.version).toBe(turnRelease.prompts[PROMPT_NAMES.agentSystemPrompt].version);
    expect(result.source).toBe('local_release');
    expect(result.text).toContain('同类场景下优先核验票型');
    expect(compile).not.toHaveBeenCalled();
  });

  it('LangFuse 拉取失败时沿用本地 fallback', async () => {
    jest.spyOn(Langfuse.prototype, 'getPrompt').mockRejectedValueOnce(new Error('offline'));
    const service = new PromptService(createConfig());

    const result = await service.render(PROMPT_NAMES.agentSpeechContent, { thinking: '投给3号' });

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
