import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';
import type { Env } from '../config/env.validation';

/**
 * Skill 元数据（不含正文，供 Skill 继承）
 */
export interface SkillMetadata {
  /** Skill ID（相对路径，例如 roles/werewolf） */
  id: string;

  name: string;

  /** 简短描述 */
  description: string;

  /** 标签 */
  tags?: string[];

  /** 适用条件 */
  conditions?: Record<string, any>;
}

/**
 * 完整 Skill
 */
export interface Skill extends SkillMetadata {
  /** 完整内容（Markdown） */
  content: string;
}

/**
 * Skill Loader Service
 *
 * 按 skillId（相对路径，如 roles/werewolf、rulesets/standard6p）加载 SKILL.md 正文。
 * 骨架类内容（行为约束 / 决策框架 / 基础规则）已内联进 LangFuse 的 agent/system-prompt 模板，
 * 本 service 只负责加载「板子规则 / 场景指令 / 角色玩法」等按条件注入的正文。
 */
@Injectable()
export class SkillLoaderService {
  private readonly logger = new Logger(SkillLoaderService.name);
  private readonly cache = new Map<string, Skill>();

  constructor(private readonly configService: ConfigService<Env, true>) {}

  /**
   * 加载完整 Skill（正文）
   *
   * @param skillId Skill ID（例如 "roles/werewolf"）
   * @param version 技能版本（默认 'v1'）
   * @returns 完整的 Skill 对象，包含内容
   */
  async loadSkill(skillId: string, version: string = 'v1'): Promise<Skill | null> {
    this.assertSafePath(skillId, version);
    const cacheKey = `${version}:${skillId}`;

    // 检查缓存
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    try {
      // 构建版本化的路径
      const skillsBaseDir =
        this.configService.get('SKILLS_DIR') || path.join(__dirname, '../skills');
      const versionRoot = path.resolve(skillsBaseDir, version);
      const versionedPath = path.resolve(versionRoot, skillId, 'SKILL.md');
      if (!versionedPath.startsWith(`${versionRoot}${path.sep}`)) {
        throw new Error(`非法 Skill 路径: ${version}:${skillId}`);
      }

      const content = await fs.readFile(versionedPath, 'utf-8');
      const { data, content: markdown } = matter(content);

      const skill: Skill = {
        id: skillId,
        name: data.name || skillId,
        description: data.description || '',
        tags: data.tags || [],
        conditions: data.conditions,
        content: markdown.trim(),
      };

      // 缓存
      this.cache.set(cacheKey, skill);
      return skill;
    } catch (error) {
      this.logger.debug(
        `版本化 Skill 加载失败 ${version}:${skillId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async loadRequiredSkill(skillId: string, version: string = 'v1'): Promise<Skill> {
    const skill = await this.loadSkill(skillId, version);
    if (!skill) {
      throw new Error(`必需 Skill 不存在或无法读取: ${version}:${skillId}`);
    }
    return skill;
  }

  private assertSafePath(skillId: string, version: string): void {
    const validSkillId = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)+$/.test(skillId);
    const validVersion = /^v[0-9]+$/.test(version);
    if (!validSkillId || !validVersion) {
      throw new Error(`非法 Skill 标识: ${version}:${skillId}`);
    }
  }

  /**
   * 清除缓存（开发调试用）
   */
  clearCache(): void {
    this.cache.clear();
  }
}
