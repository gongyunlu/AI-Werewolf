import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Env } from '../config/env.validation';

export interface SkillContent {
  type: 'rule' | 'role';
  role?: string; // 仅 type=role 时有效
  content: string;
}

/**
 * Skill Loader Service
 *
 * 渐进式披露架构：
 * - Layer 0: 核心决策框架（永远加载）
 * - Layer 1: 规则（根据板子加载）
 * - Layer 2: 角色（根据身份加载）
 * - Layer 3: 战术（根据场景按需加载）
 */
@Injectable()
export class SkillLoaderService {
  private readonly skillsDir: string;
  private cache = new Map<string, string>(); // 缓存 Skill 内容

  constructor(private readonly configService: ConfigService<Env, true>) {
    // 从环境变量读取 SKILLS_DIR，如果未配置则使用默认路径
    const envSkillsDir = this.configService.get('SKILLS_DIR');
    this.skillsDir = envSkillsDir || path.join(__dirname, '..', 'skills');

    console.log(`[SkillLoader] Skill 目录: ${this.skillsDir}`);
  }

  /**
   * Layer 0: 加载核心决策框架（永远加载）
   */
  async loadCoreFramework(): Promise<string> {
    const cacheKey = 'core:framework';
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const filePath = path.join(this.skillsDir, 'core', 'decision-framework.md');
    const content = await fs.readFile(filePath, 'utf-8');
    this.cache.set(cacheKey, content);
    return content;
  }

  /**
   * Layer 1: 加载狼人杀规则 Skill
   */
  async loadRuleSkill(version: string = 'v1'): Promise<string> {
    const cacheKey = `rule:${version}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const filePath = path.join(this.skillsDir, version, 'rules', 'werewolf-rules.md');
    const content = await fs.readFile(filePath, 'utf-8');
    this.cache.set(cacheKey, content);
    return content;
  }

  /**
   * Layer 2: 加载角色 Skill
   *
   * @param role - 角色名称（werewolf, seer, witch, villager）
   * @param version - 版本号（默认 v1）
   */
  async loadRoleSkill(role: string, version: string = 'v1'): Promise<string> {
    const cacheKey = `role:${role}:${version}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const filePath = path.join(this.skillsDir, version, 'roles', `${role}.md`);
    const content = await fs.readFile(filePath, 'utf-8');
    this.cache.set(cacheKey, content);
    return content;
  }

  /**
   * Layer 3: 加载战术 Skill（按需加载）
   *
   * @param category - 战术分类（wolf/good/counter）
   * @param tactic - 具体战术名称（bluff/backstab/identify-bluff 等）
   * @param version - 版本号（默认 v1）
   */
  async loadTactic(category: string, tactic: string, version: string = 'v1'): Promise<string> {
    const cacheKey = `tactic:${category}:${tactic}:${version}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const filePath = path.join(this.skillsDir, version, 'tactics', category, `${tactic}.md`);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      this.cache.set(cacheKey, content);
      return content;
    } catch {
      // 战术文件不存在时返回空字符串（战术是可选的）
      console.warn(`[SkillLoader] 战术文件不存在: ${filePath}`);
      return '';
    }
  }

  /**
   * 批量加载战术（按分类）
   *
   * @param category - 战术分类（wolf/good/counter）
   * @param version - 版本号（默认 v1）
   */
  async loadTacticsByCategory(category: string, version: string = 'v1'): Promise<string> {
    const cacheKey = `tactics:${category}:${version}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const dirPath = path.join(this.skillsDir, version, 'tactics', category);

    try {
      const files = await fs.readdir(dirPath);
      const mdFiles = files.filter((f) => f.endsWith('.md'));

      const contents = await Promise.all(
        mdFiles.map(async (file) => {
          const filePath = path.join(dirPath, file);
          return await fs.readFile(filePath, 'utf-8');
        }),
      );

      const combined = contents.join('\n\n---\n\n');
      this.cache.set(cacheKey, combined);
      return combined;
    } catch {
      console.warn(`[SkillLoader] 战术目录不存在: ${dirPath}`);
      return '';
    }
  }

  /**
   * 更新角色 Skill（用于 AI 自我优化）
   *
   * @param role - 角色名称
   * @param content - 新的 Skill 内容
   * @param version - 版本号（默认 v1）
   */
  async updateRoleSkill(role: string, content: string, version: string = 'v1'): Promise<void> {
    const filePath = path.join(this.skillsDir, version, 'roles', `${role}.md`);
    await fs.writeFile(filePath, content, 'utf-8');

    // 清除缓存
    const cacheKey = `role:${role}:${version}`;
    this.cache.delete(cacheKey);
  }

  /**
   * 创建新版本的 Skill（从现有版本复制）
   *
   * @param fromVersion - 源版本
   * @param toVersion - 目标版本
   */
  async createVersion(fromVersion: string, toVersion: string): Promise<void> {
    const fromDir = path.join(this.skillsDir, fromVersion);
    const toDir = path.join(this.skillsDir, toVersion);

    // 检查目标版本是否已存在
    try {
      await fs.access(toDir);
      throw new Error(`版本 ${toVersion} 已存在`);
    } catch {
      // 目标版本不存在，继续
    }

    // 复制整个目录
    await fs.cp(fromDir, toDir, { recursive: true });
    console.log(`[SkillLoader] 创建新版本: ${fromVersion} -> ${toVersion}`);
  }

  /**
   * 清除缓存（开发调试用）
   */
  clearCache(): void {
    this.cache.clear();
  }
}
