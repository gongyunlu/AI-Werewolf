import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Langfuse } from 'langfuse-langchain';
import type { Env } from '../config/env.validation';
import type { FrozenPrompts } from '../evaluation/experiment-snapshot';
import { ExperimentInvalidError } from '../evaluation/experiment-integrity';
import {
  extractPromptVariables,
  FALLBACK_TEMPLATES,
  REQUIRED_PROMPT_VARIABLES,
  renderTemplate,
  type PromptName,
} from './prompt-templates';

// prompt 渲染结果
export interface RenderedPrompt {
  text: string;
  name: PromptName;
  version: number | null;
}

// 在线 prompt 的本地缓存 TTL（秒）：在 Langfuse 面板修改 prompt 后，最多等待该时长即生效
const CACHE_TTL_SECONDS = 60;

/**
 * Prompt 管理
 * 失败时降级到本地默认模板（prompt-templates.ts）
 */
@Injectable()
export class PromptService {
  private readonly logger = new Logger(PromptService.name);
  private readonly langfuse: Langfuse | null;

  constructor(private readonly configService: ConfigService<Env, true>) {
    const publicKey = this.configService.get('LANGFUSE_PUBLIC_KEY');
    const secretKey = this.configService.get('LANGFUSE_SECRET_KEY');
    const baseUrl = this.configService.get('LANGFUSE_HOST');

    if (!publicKey || !secretKey) {
      this.logger.warn('LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY 未配置，prompt 走本地默认模板');
      this.langfuse = null;
      return;
    }

    this.langfuse = new Langfuse({ publicKey, secretKey, baseUrl });
  }

  /**
   * 拉取并渲染 prompt。
   *
   * @param name prompt 名称
   * @param variables `{{var}}` 占位符的取值，缺失渲染为空串
   */
  async render(
    name: PromptName,
    variables?: Record<string, string>,
    frozen?: FrozenPrompts,
  ): Promise<RenderedPrompt> {
    const template = frozen ? frozen[name] : await this.loadTemplate(name);
    if (!template) throw new ExperimentInvalidError(`实验快照缺少 prompt: ${name}`);
    return { text: renderTemplate(template.text, variables), name, version: template.version };
  }

  async captureSnapshot(
    names: PromptName[] = (Object.keys(FALLBACK_TEMPLATES) as PromptName[]).filter(
      (name) => !name.startsWith('memory/') && !name.startsWith('reflection/'),
    ),
  ): Promise<FrozenPrompts> {
    const entries = await Promise.all(
      names.map(async (name) => [name, await this.loadTemplate(name)] as const),
    );
    return Object.fromEntries(entries);
  }

  private async loadTemplate(name: PromptName): Promise<RenderedPrompt> {
    const fallback = FALLBACK_TEMPLATES[name];

    if (!this.langfuse) {
      return { text: fallback, name, version: null };
    }

    try {
      const client = await this.langfuse.getPrompt(name, undefined, {
        label: 'production',
        cacheTtlSeconds: CACHE_TTL_SECONDS,
      });

      const onlineVariables = new Set(extractPromptVariables(client.prompt));
      const missingVariables = REQUIRED_PROMPT_VARIABLES[name].filter(
        (variable) => !onlineVariables.has(variable),
      );
      if (missingVariables.length > 0) {
        throw new Error(`production 版本缺少必需变量: ${missingVariables.join(', ')}`);
      }

      return { text: client.prompt, name, version: client.version };
    } catch (error) {
      this.logger.warn(
        `prompt "${name}" 拉取或校验失败，降级本地默认模板: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { text: fallback, name, version: null };
    }
  }
}
