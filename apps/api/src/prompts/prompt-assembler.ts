import type { Role } from '@ai-werewolf/shared';
import type { ActiveMemory } from '../memory/memory.service';
import { FRAMEWORK_PROMPT, ROLE_PROMPTS } from './prompts';

const getRolePrompt = (role: Role): string => {
  const prompt = ROLE_PROMPTS[role];
  if (!prompt) {
    throw new Error(
      `未在 ROLE_PROMPTS 中登记角色: ${role}，请补充 apps/api/src/prompts/prompts.ts`,
    );
  }
  return prompt;
};

const formatMemoryBlock = (title: string, memories: ActiveMemory[]): string => {
  if (memories.length === 0) return '';
  const lines = memories.map((m) => `- ${m.title}：${m.content}`);
  return `## ${title}\n\n${lines.join('\n')}\n`;
};

/**
 * 分层装配 system prompt：
 *   framework > persona（个人特质）> role（角色视角）> strategy（战术倾向）> experience（经验教训）
 *
 * persona 描述"你是什么样的人"，先于角色注入，让角色发言染上性格底色。
 * strategy 描述"你怎么打"，放在角色之后，作为角色行为的细化。
 * experience 目前留空，后续memory 接入后按需注入。
 */
export const assembleVotingSystemPrompt = (params: {
  role: Role;
  memories: ActiveMemory[];
}): string => {
  const { role, memories } = params;
  const persona = memories.filter((m) => m.type === 'persona');
  const strategy = memories.filter((m) => m.type === 'strategy');
  const experience = memories.filter((m) => m.type !== 'persona' && m.type !== 'strategy');

  return [
    FRAMEWORK_PROMPT,
    formatMemoryBlock('你的个人特质', persona),
    getRolePrompt(role),
    formatMemoryBlock('你的战术倾向', strategy),
    formatMemoryBlock('相关经验', experience),
  ]
    .filter((s) => s.length > 0)
    .join('\n');
};
