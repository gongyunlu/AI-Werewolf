import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';
import type { Env } from '../config/env.validation';

/**
 * Skill 元数据（L1）
 *
 * 轻量级元数据，用于构建技能目录
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
 * 向后兼容的 Skill 内容格式
 */
export interface SkillContent {
  type: 'rule' | 'role';
  role?: string;
  content: string;
}

/**
 * Skill Loader Service
 *
 * 遵循 LangChain Agent Skills Specification
 * 支持三级渐进式披露（L1/L2/L3）：
 * - L1: Metadata（元数据目录，启动时加载）
 * - L2: Core Content（完整指令，按需加载）
 * - L3: Supporting Resources（支持资源，按需加载，暂未实现）
 *
 * 架构：
 * - Layer 0: 核心决策框架（加载到 System Prompt）
 * - Layer 1: 角色技能
 * - Layer 2: 板子规则
 * - Layer 3: 战术技能
 * - Layer 4: 高级套路
 */
@Injectable()
export class SkillLoaderService implements OnModuleInit {
  private readonly skillsDir: string;
  private readonly cache = new Map<string, Skill>();
  private catalog: SkillMetadata[] = [];

  constructor(private readonly configService: ConfigService<Env, true>) {
    const envSkillsDir = this.configService.get('SKILLS_DIR', { infer: true });
    // 当前只支持 v1，未来可以根据配置或参数动态选择版本
    this.skillsDir = envSkillsDir || path.join(__dirname, 'v1');
  }

  async onModuleInit() {
    await this.loadCatalog();
  }

  /**
   * 加载 L1 目录（所有 Skill 的元数据）
   *
   * 扫描所有 SKILL.md 文件，提取 frontmatter 作为元数据
   */
  private async loadCatalog(): Promise<void> {
    this.catalog = [];

    try {
      // 扫描所有分类目录
      const categories = await fs.readdir(this.skillsDir, { withFileTypes: true });

      for (const category of categories) {
        if (!category.isDirectory()) continue;

        const categoryPath = path.join(this.skillsDir, category.name);
        await this.scanCategory(categoryPath, category.name);
      }
    } catch {
      //
    }
  }

  /**
   * 扫描一个分类目录
   */
  private async scanCategory(categoryPath: string, categoryName: string): Promise<void> {
    try {
      const skills = await fs.readdir(categoryPath, { withFileTypes: true });

      for (const skill of skills) {
        if (!skill.isDirectory()) continue;

        const skillId = `${categoryName}/${skill.name}`;
        const metadata = await this.loadMetadata(skillId);

        if (metadata) {
          this.catalog.push(metadata);
        }
      }
    } catch {
      //
    }
  }

  /**
   * 加载单个 Skill 的元数据（L1）
   *
   * 读取 SKILL.md 的 frontmatter
   */
  private async loadMetadata(skillId: string): Promise<SkillMetadata | null> {
    try {
      const skillPath = path.join(this.skillsDir, skillId, 'SKILL.md');
      const content = await fs.readFile(skillPath, 'utf-8');
      const { data } = matter(content);

      return {
        id: skillId,
        name: data.name || skillId,
        description: data.description || '',
        tags: data.tags || [],
        conditions: data.conditions,
      };
    } catch {
      // SKILL.md 不存在，尝试向后兼容的格式
      return this.loadLegacyMetadata(skillId);
    }
  }

  /**
   * 向后兼容：加载旧格式的元数据
   */
  private async loadLegacyMetadata(skillId: string): Promise<SkillMetadata | null> {
    try {
      // 尝试读取 {skillName}.md 文件
      const [category, skillName] = skillId.split('/');
      const legacyPath = path.join(this.skillsDir, category, `${skillName}.md`);

      await fs.access(legacyPath);

      // 文件存在，返回基础元数据
      return {
        id: skillId,
        name: skillName,
        description: `${skillName} 技能`,
        tags: [category],
      };
    } catch {
      return null;
    }
  }

  /**
   * 获取 L1 目录（带条件过滤）
   *
   * @param context 上下文对象，用于条件过滤
   * @returns 过滤后的 Skill 元数据列表
   */
  getCatalog(context?: Record<string, any>): SkillMetadata[] {
    if (!context) {
      return this.catalog;
    }

    // 根据 context 过滤
    return this.catalog.filter((skill) => this.checkConditions(skill.conditions, context));
  }

  /**
   * 获取 L1 目录的 Markdown 格式
   *
   * @param context 上下文对象，用于条件过滤
   * @returns Markdown 格式的目录
   */
  getCatalogMarkdown(context?: Record<string, any>): string {
    const catalog = this.getCatalog(context);

    if (catalog.length === 0) {
      return '';
    }

    const lines: string[] = [
      '## 可用技能库',
      '',
      '你可以通过 `load_skill` 工具加载以下技能的详细内容：',
      '',
    ];

    // 按分类分组
    const byCategory = new Map<string, SkillMetadata[]>();
    for (const skill of catalog) {
      const category = skill.id.split('/')[0];
      if (!byCategory.has(category)) {
        byCategory.set(category, []);
      }
      byCategory.get(category)!.push(skill);
    }

    // 格式化输出
    for (const [category, skills] of byCategory) {
      lines.push(`### ${this.getCategoryName(category)}`, '');
      for (const skill of skills) {
        const tags = skill.tags && skill.tags.length > 0 ? ` [${skill.tags.join(', ')}]` : '';
        lines.push(`- \`${skill.id}\` - ${skill.name}${tags}`);
        if (skill.description) {
          lines.push(`  ${skill.description}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 加载完整 Skill（L1 + L2）
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
   * 根据标签查找 Skill
   *
   * @param tags 标签列表
   * @returns 匹配的 Skill 元数据列表
   */
  findSkillsByTags(tags: string[]): SkillMetadata[] {
    return this.catalog.filter(
      (skill) => skill.tags && tags.some((tag) => skill.tags!.includes(tag)),
    );
  }

  /**
   * 检查条件
   */
  private checkConditions(
    conditions: Record<string, any> | undefined,
    context: Record<string, any>,
  ): boolean {
    if (!conditions) return true;

    for (const [key, value] of Object.entries(conditions)) {
      const contextValue = context[key];

      if (Array.isArray(value)) {
        // 条件是数组：检查上下文值是否在数组中
        if (!value.includes(contextValue)) return false;
      } else if (typeof value === 'object' && value !== null) {
        // 条件是对象：支持复杂条件
        if (value.$in && !value.$in.includes(contextValue)) return false;
        if (value.$exists !== undefined) {
          const exists = contextValue !== undefined;
          if (exists !== value.$exists) return false;
        }
      } else {
        // 条件是简单值：直接比较
        if (contextValue !== value) return false;
      }
    }

    return true;
  }

  /**
   * 获取分类名称
   */
  private getCategoryName(category: string): string {
    const names: Record<string, string> = {
      core: '核心框架',
      roles: '角色技能',
      rulesets: '板子规则',
      tactics: '战术技能',
      advanced: '高级套路',
    };
    return names[category] || category;
  }

  /**
   * 清除缓存（开发调试用）
   */
  clearCache(): void {
    this.cache.clear();
  }

  // ==================== 向后兼容的方法 ====================

  /**
   * @deprecated 使用 loadSkill() 代替
   * @param role 角色名称
   * @param version 技能版本（默认 'v1'）
   */
  async loadRoleSkill(role: string, version: string = 'v1'): Promise<string> {
    const skillId = `roles/${role}`;
    const skill = await this.loadSkill(skillId, version);
    return skill?.content || '';
  }

  /**
   * @deprecated 使用 loadSkill() 代替
   * @param ruleName 规则名称
   * @param version 技能版本（默认 'v1'）
   */
  async loadRuleSkill(ruleName: string, version: string = 'v1'): Promise<string> {
    const skillId = `core/${ruleName}`;
    const skill = await this.loadSkill(skillId, version);
    return skill?.content || '';
  }

  /**
   * @deprecated 使用 loadSkill() 代替
   * @param skillType 技能类型
   * @param name 技能名称
   * @param version 技能版本（默认 'v1'）
   */
  async loadSkillContent(
    skillType: 'rule' | 'role',
    name: string,
    version: string = 'v1',
  ): Promise<SkillContent> {
    const skillId = skillType === 'role' ? `roles/${name}` : `core/${name}`;
    const skill = await this.loadSkill(skillId, version);

    return {
      type: skillType,
      role: skillType === 'role' ? name : undefined,
      content: skill?.content || '',
    };
  }
}
