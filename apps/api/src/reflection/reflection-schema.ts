import { LessonConditionsSchema } from '../memory/lesson-applicability';
import { z } from 'zod';
import { RoleSchema } from '@ai-werewolf/shared';

/** lesson 适用场景枚举：AGENT_SCENARIOS 的 5 个值 + any（不限） */
const LessonScenarioSchema = z.enum([
  'vote',
  'day_speech',
  'night_action',
  'last_words',
  'sheriff_decide_order',
  'any',
]);

/**
 * 对局级开眼复盘的结构化输出。
 *
 * 由一次上帝视角调用产出，作为全部玩家反思的共同输入，避免每个玩家各自重新消化整局。
 */
export const GameReviewOutputSchema = z.object({
  /** 复盘正文：胜负是怎么走出来的 */
  narrative: z.string().min(1).max(2000),
  /** 关键转折点：改变了走向的那几步 */
  turningPoints: z
    .array(
      z.object({
        day: z.number().int().min(0),
        description: z.string().min(1).max(200),
      }),
    )
    .max(6),
  /** 板子层面的客观规律，与具体座位/身份无关，可迁移到下一局 */
  patterns: z
    .array(
      z.object({
        title: z.string().min(1).max(60),
        content: z.string().min(1).max(300),
        importance: z.number().min(0).max(1),
      }),
    )
    .max(5),
});
export type GameReviewOutput = z.infer<typeof GameReviewOutputSchema>;

/**
 * 玩家级反思的结构化输出。
 *
 * lesson 强制 trigger/action/evidence 三段：trigger 决定下一局什么场景下该被检索出来，
 * 只有「我应该更谨慎」这种没有触发条件的教训无法被注入，也无法归因。
 */
export const ReflectionOutputSchema = z.object({
  /** 本局复盘：我做对了什么、错在哪 */
  summary: z.string().min(1).max(1200),
  lessons: z
    .array(
      z.object({
        title: z.string().min(1).max(60),
        /** 触发条件：什么局面下这条经验适用（如「我是预言家、首夜验出金水、场上已有人起跳」） */
        trigger: z.string().min(1).max(200),
        /** 应当采取的行动，要具体到可执行 */
        action: z.string().min(1).max(300),
        /** 本局支撑该结论的事实 */
        evidence: z.string().min(1).max(300),
        importance: z.number().min(0).max(1),
        /** 适用角色：这条经验只在玩家是某角色时成立；对所有身份都成立才显式填 any */
        role: RoleSchema.or(z.literal('any')),
        /** 适用场景：这条经验在哪个场景注入时成立；跨场景才显式填 any */
        scenario: LessonScenarioSchema,
        conditions: LessonConditionsSchema.describe(
          '从可枚举事实中列出触发所必需的条件；首夜/后续夜、已救人、已公开讨论等。没有这些限定才填空数组',
        ),
      }),
    )
    .max(5),
  /** 对手建模：每个对手一条，覆盖式更新既有建模 */
  playerModels: z
    .array(
      z.object({
        /** 对手的 Agent 名称，必须取自输入里给出的同桌名单 */
        agentName: z.string().trim().min(1).max(64),
        content: z.string().min(1).max(400),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(8)
    .superRefine((models, ctx) => {
      const seen = new Set<string>();
      models.forEach((model, index) => {
        if (seen.has(model.agentName)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'agentName'],
            message: `同一对手只能输出一条建模：${model.agentName}`,
          });
        }
        seen.add(model.agentName);
      });
    }),
});
export type ReflectionOutput = z.infer<typeof ReflectionOutputSchema>;
