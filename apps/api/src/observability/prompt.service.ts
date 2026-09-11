import { Injectable, Logger, Optional } from '@nestjs/common';
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

import turnRelease from './turn-prompt-release.json';
import { RedisService } from '../redis/redis.service';

// prompt 渲染结果
export interface RenderedPrompt {
  text: string;
  name: PromptName;
  version: number | null;
  source?: 'langfuse' | 'local_release' | 'local_default';
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

  private readonly localSnapshots = new Map<string, Promise<FrozenPrompts>>();

  constructor(
    private readonly configService: ConfigService<Env, true>,
    @Optional() private readonly redis?: RedisService,
  ) {
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
    return { ...template, text: renderTemplate(template.text, variables), name };
  }

  /** 使用 SET NX 决定同局唯一版本，避免并发玩家各自获取 production。 */
  async captureGameSnapshot(gameId: string, names: PromptName[]): Promise<FrozenPrompts> {
    if (!this.redis) {
      let pending = this.localSnapshots.get(gameId);
      if (!pending) {
        pending = this.captureSnapshot(names).catch((error) => {
          this.localSnapshots.delete(gameId);
          throw error;
        });
        this.localSnapshots.set(gameId, pending);
      }
      return structuredClone(await pending);
    }
    const key = 'game:' + gameId + ':player-prompts';
    const existing = await this.redis.get(key);
    if (existing) return JSON.parse(existing) as FrozenPrompts;
    const snapshot = await this.captureSnapshot(names);
    // 和事件/快照一同保留，不设置会在长局中途过期的 TTL。
    if (await this.redis.set(key, JSON.stringify(snapshot), 'NX')) return snapshot;
    const winner = await this.redis.get(key);
    if (!winner) throw new Error('对局 Prompt 快照写入后不可读取');
    return JSON.parse(winner) as FrozenPrompts;
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
    const candidate = (turnRelease.prompts as FrozenPrompts)[name];
    const released =
      candidate &&
      REQUIRED_PROMPT_VARIABLES[name].every((variable) =>
        extractPromptVariables(candidate.text).includes(variable),
      )
        ? candidate
        : undefined;
    const fallback = released?.text ?? FALLBACK_TEMPLATES[name];
    const local: RenderedPrompt = {
      text: fallback,
      name,
      version: released?.version ?? null,
      source: released ? 'local_release' : 'local_default',
    };

    if (!this.langfuse) {
      return local;
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

      return { text: client.prompt, name, version: client.version, source: 'langfuse' };
    } catch (error) {
      this.logger.warn(
        `prompt "${name}" 拉取或校验失败，使用本地副本: ${error instanceof Error ? error.message : String(error)}`,
      );
      return local;
    }
  }
}
