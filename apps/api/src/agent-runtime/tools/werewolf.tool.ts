import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { ToolContext } from './tool-context';

const WolfChatInputSchema = z.object({
  message: z.string().min(1).max(500).describe('要发送的消息内容'),
});

const ProposeKillInputSchema = z.object({
  targetSeatNo: z.number().int().min(1).describe('要刀杀的目标玩家座位号'),
  reason: z.string().max(200).optional().describe('刀人理由（可选）'),
});

const WolfChatOutputSchema = z.object({
  action: z.literal('wolf_chat'),
  actorId: z.string(),
  message: z.string(),
});

const ProposeKillOutputSchema = z.object({
  action: z.literal('propose_kill'),
  actorId: z.string(),
  targetSeatNo: z.number().int().min(1),
  reason: z.string().optional(),
});

export type WolfChatOutput = z.infer<typeof WolfChatOutputSchema>;
export type ProposeKillOutput = z.infer<typeof ProposeKillOutputSchema>;

/**
 * 狼人聊天工具
 */
export const createWolfChatTool = (ctx: ToolContext) =>
  tool(
    async (input): Promise<WolfChatOutput> => {
      return {
        action: 'wolf_chat',
        actorId: ctx.currentPlayerId,
        message: input.message,
      };
    },
    {
      name: 'wolf_chat',
      description: `
        狼人专属：在狼队频道发送消息，与队友讨论刀人策略。消息仅狼队可见。

        使用要求：
        - 必须明确提出建议，例如："我建议刀3号位，因为他发言像预言家"
        - 如果没有明确理由，也要说"建议随机刀X号位"
        - 可以表示同意队友的提议："同意刀X号位"
        - 避免说废话或重复分析局面
      `.trim(),
      schema: WolfChatInputSchema,
    },
  );

/**
 * 狼人刀人工具
 */
export const createProposeKillTool = (ctx: ToolContext) =>
  tool(
    async (input): Promise<ProposeKillOutput> => {
      return {
        action: 'propose_kill',
        actorId: ctx.currentPlayerId,
        targetSeatNo: input.targetSeatNo,
        reason: input.reason,
      };
    },
    {
      name: 'propose_kill',
      description:
        '狼人专属：提议刀杀目标玩家。这是最终动作，一旦调用即视为你的刀人投票已确定。所有狼人的提议会被统计，得票最多的目标将被刀杀。目标可以是任何存活玩家（包括自己，自刀是一种高级策略）。',
      schema: ProposeKillInputSchema,
    },
  );
