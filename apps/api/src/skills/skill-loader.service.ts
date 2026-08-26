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
  private readonly skillsDir: string;
  private readonly cache = new Map<string, Skill>();

  constructor(private readonly configService: ConfigService<Env, true>) {
    const envSkillsDir = this.configService.get('SKILLS_DIR', { infer: true });
    // 当前只支持 v1
    this.skillsDir = envSkillsDir || path.join(__dirname, 'v1');
  }

  /**
   * 加载完整 Skill（正文）
   *
   * @param skillId Skill ID（例如 "roles/werewolf"）
   * @param version 技能版本（默认 'v1'）
   * @returns 完整的 Skill 对象，包含内容
   */
  async loadSkill(skillId: string, version: string = 'v1'): Promise<Skill | null> {
    const cacheKey = `${version}:${skillId}`;

    // 检查缓存
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    try {
      // 构建版本化的路径
      const skillsBaseDir =
        this.configService.get('SKILLS_DIR') || path.join(__dirname, '../skills');
      const versionedPath = path.join(skillsBaseDir, version, skillId, 'SKILL.md');

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
    } catch {
      // SKILL.md 不存在，尝试向后兼容
      return this.loadLegacySkill(skillId);
    }
  }

  /**
   * 向后兼容：加载旧格式的 Skill
   */
  private async loadLegacySkill(skillId: string): Promise<Skill | null> {
    try {
      const [category, skillName] = skillId.split('/');
      const legacyPath = path.join(this.skillsDir, category, `${skillName}.md`);

      const content = await fs.readFile(legacyPath, 'utf-8');

      const skill: Skill = {
        id: skillId,
        name: skillName,
        description: `${skillName} 技能`,
        tags: [category],
        content: content.trim(),
      };

      // 缓存
      this.cache.set(skillId, skill);
      return skill;
    } catch {
      return null;
    }
  }

  /**
   * 清除缓存（开发调试用）
   */
  clearCache(): void {
    this.cache.clear();
  }
}
