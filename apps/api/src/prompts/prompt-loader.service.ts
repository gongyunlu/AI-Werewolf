import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Env } from '../config/env.validation';
import type { AgentScenario } from '@ai-werewolf/shared';
import { AGENT_SCENARIOS } from '@ai-werewolf/shared';

/**
 * Prompt Loader Service
 *
 * 管理基础行为约束和场景指令（简洁、固定）
 */
@Injectable()
export class PromptLoaderService implements OnModuleInit {
  private cache = new Map<string, string>();
  private readonly templatesDir: string;

  constructor(private readonly configService: ConfigService<Env, true>) {
    const envPromptsDir = this.configService.get('PROMPTS_DIR');
    this.templatesDir = envPromptsDir || path.join(__dirname, 'templates');
  }

  async onModuleInit() {
    await this.loadAll();

    // 验证核心 prompt 是否存在
    const requiredPrompts = ['common/constraints'];
    for (const key of requiredPrompts) {
      if (!this.has(key)) {
        throw new Error(`必需的 Prompt 未加载: ${key}. 可能是 PROMPTS_DIR 配置错误或文件缺失`);
      }
    }
  }

  /**
   * 递归加载所有 .md 文件到缓存
   */
  private async loadAll(): Promise<void> {
    await this.loadDirectory(this.templatesDir, '');
  }

  private async loadDirectory(dir: string, prefix: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await this.loadDirectory(fullPath, `${prefix}${entry.name}/`);
        } else if (entry.name.endsWith('.md')) {
          const key = `${prefix}${entry.name.replace('.md', '')}`;
          const content = await fs.readFile(fullPath, 'utf-8');
          this.cache.set(key, content);
        }
      }
    } catch (error) {
      // 目录不存在时跳过
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * 加载基础行为约束
   */
  loadConstraints(): string {
    return this.get('common/constraints');
  }

  /**
   * 加载场景指令
   */
  loadScenarioPrompt(scenario: AgentScenario): string {
    const scenarioKeyMap: Partial<Record<AgentScenario, string>> = {
      [AGENT_SCENARIOS.VOTE]: 'scenario/vote',
      [AGENT_SCENARIOS.DAY_SPEECH]: 'scenario/day-speech',
      [AGENT_SCENARIOS.NIGHT_ACTION]: 'scenario/night-action',
      [AGENT_SCENARIOS.LAST_WORDS]: 'scenario/last-words',
    };

    const key = scenarioKeyMap[scenario];
    if (!key) {
      throw new Error(`场景 ${scenario} 的 Prompt 尚未实现`);
    }
    return this.get(key);
  }

  /**
   * 获取提示词内容（底层方法，一般不直接使用）
   *
   * @param key - 提示词 key，例如 "common/constraints"
   * @returns 提示词内容
   * @throws 如果 key 不存在
   */
  private get(key: string): string {
    const content = this.cache.get(key);
    if (content === undefined) {
      throw new Error(
        `Prompt not found: ${key}. Available keys: ${Array.from(this.cache.keys()).join(', ')}`,
      );
    }
    return content;
  }

  /**
   * 检查提示词是否存在
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * 获取所有已加载的提示词 key
   */
  getKeys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cache.clear();
  }
}
