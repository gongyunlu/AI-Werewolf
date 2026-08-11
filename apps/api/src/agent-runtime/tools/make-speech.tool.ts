import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { ToolContext } from './tool-context';

const InputSchema = z.object({
  content: z
    .string()
    .min(1, '发言内容不能为空')
    .max(500, '发言内容不能超过500字')
    .describe('发言内容'),
});

const OutputSchema = z.object({
  action: z.literal('make_speech'),
  actorId: z.string(),
  content: z.string(),
});

export type MakeSpeechOutput = z.infer<typeof OutputSchema>;

/**
 * 发言工具
 */
export const createMakeSpeechTool = (ctx: ToolContext) =>
  tool(
    async (input): Promise<MakeSpeechOutput> => {
      return {
        action: 'make_speech',
        actorId: ctx.currentPlayerId,
        content: input.content,
      };
    },
    {
      name: 'make_speech',
      description:
        '白天发言：向所有玩家公开发表你的观点。发言内容会被记录并公开给所有人。你可以自由发言，包括跳身份（悍跳）、分析局势、指认嫌疑人等。',
      schema: InputSchema,
    },
  );
