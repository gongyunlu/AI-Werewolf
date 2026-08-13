import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { SkillLoaderService } from '../skill-loader.service';

/**
 * 创建 load_skill 工具
 *
 * 允许 Agent 按需加载技能的详细内容
 */
export function createLoadSkillTool(
  skillLoader: SkillLoaderService,
  loadedSkills: Set<string>,
  version: string = 'v1',
) {
  return new DynamicStructuredTool({
    name: 'load_skill',
    description: '加载指定技能的详细内容。当你需要某个技能的完整指导时调用此工具。',
    schema: z.object({
      skillId: z.string().describe('技能 ID，例如 "roles/werewolf"'),
      reason: z.string().optional().describe('加载此技能的原因（可选）'),
    }),
    func: async ({ skillId, reason }) => {
      const cacheKey = `${version}:${skillId}`;

      // 检查是否已加载
      if (loadedSkills.has(cacheKey)) {
        return JSON.stringify({
          success: true,
          alreadyLoaded: true,
          message: `技能 ${skillId} 已在本次会话中加载过`,
        });
      }

      // 加载技能
      const skill = await skillLoader.loadSkill(skillId, version);

      if (!skill) {
        return JSON.stringify({
          success: false,
          error: `技能 ${skillId} 不存在（版本：${version}）`,
        });
      }

      // 标记为已加载
      loadedSkills.add(cacheKey);

      return JSON.stringify({
        success: true,
        skillId: skill.id,
        name: skill.name,
        content: skill.content,
        loadReason: reason,
      });
    },
  });
}
