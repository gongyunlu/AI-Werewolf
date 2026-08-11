import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { ToolContext } from './tool-context';

/**
 * 警长决定发言顺序工具
 *
 * 使用场景：
 * - 警长在白天发言前，决定发言的方向（从警长左手还是右手开始）
 *
 * 规则：
 * - direction 可选 left（左手，逆时针）或 right（右手，顺时针）
 * - 起始位置自动计算：从警长的左边或右边第一个存活玩家开始
 * - 警长自己始终最后发言（归票）
 */

const InputSchema = z.object({
  direction: z
    .enum(['left', 'right'])
    .describe('发言方向：left=从警长左手开始（逆时针），right=从警长右手开始（顺时针）'),
});

const OutputSchema = z.object({
  action: z.literal('decide_speech_order'),
  direction: z.enum(['left', 'right']),
});

export type DecideSpeechOrderOutput = z.infer<typeof OutputSchema>;

export const createDecideSpeechOrderTool = (_ctx: ToolContext) =>
  tool(
    async (input): Promise<DecideSpeechOrderOutput> => {
      return {
        action: 'decide_speech_order',
        direction: input.direction,
      };
    },
    {
      name: 'decide_speech_order',
      description: `警长决定今天的发言方向（左手还是右手）。
你需要考虑：
1. 让可疑的人先发言还是后发言？
2. 哪个方向对你的阵营有利？
3. 你自己会最后发言（归票），可以总结所有人的发言后再表态

参数：
- direction: left（从你左手开始，逆时针）或 right（从你右手开始，顺时针）`,
      schema: InputSchema,
      responseFormat: 'content_and_artifact',
    },
  );
