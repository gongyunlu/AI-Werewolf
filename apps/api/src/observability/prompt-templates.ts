/**
 * 本地 fallback 的 prompt 模板
 */

export const PROMPT_NAMES = {
  agentSystemPrompt: 'agent/system-prompt',
  agentReasoning: 'agent/reasoning',
  agentSpeechThinking: 'agent/speech-thinking',
  agentSpeechContent: 'agent/speech-content',
  agentDecisionSystem: 'agent/decision-system',
  agentDecisionUser: 'agent/decision-user',
  judgeSystem: 'judge/system',
  judgeUser: 'judge/user',
  summarizerGlobalSummary: 'summarizer/global-summary',
  summarizerJudgmentHuman: 'summarizer/judgment-human',
  wolfCoordination: 'game/wolf-coordination',
} as const;

export type PromptName = (typeof PROMPT_NAMES)[keyof typeof PROMPT_NAMES];

export const FALLBACK_TEMPLATES: Record<PromptName, string> = {
  [PROMPT_NAMES.agentSystemPrompt]: `
    请使用中文进行思考和推理。所有输出（包括推理过程）必须使用中文。

    {{constraints}}
    {{roleView}}
    {{teammateInfo}}
    {{scenarioPrompt}}
    {{additionalContext}}

    ## 核心决策框架
    {{coreFramework}}

    ## 狼人杀基础规则
    {{basicRules}}

    ## 当前板子规则
    {{rulesetRules}}

    ## 可用技能目录
    {{skillCatalog}}

    ## 你的人设
    {{persona}}

    ## 你的策略
    {{strategy}}
    {{roleSpecificInfo}}

    ## 关键信息
    {{critical}}

    ## 最近一轮详细
    {{recent}}

    ## 历史摘要
    {{history}}
  `,

  [PROMPT_NAMES.agentReasoning]:
    '你已明确自己的身份、阵营与队友（见系统提示）。请直接基于当前局势进行推理，输出你的下一步判断与理由，不要重复介绍身份或队友。',

  [PROMPT_NAMES.agentSpeechThinking]:
    '你已明确自己的身份、阵营与队友（见系统提示）。请直接分析当前局势，输出你的思考过程，不要重复介绍身份或队友，不要任何前缀标记或 JSON。',

  [PROMPT_NAMES.agentSpeechContent]: `
    你的思考过程如下：

    {{thinking}}

    请基于以上思考，输出你的发言内容。直接输出发言正文，不要重复自我介绍，不要任何前缀、标题、JSON 或额外解释。
  `,

  [PROMPT_NAMES.agentDecisionSystem]: `
    {{systemPrompt}}

    ## 决策任务
    请基于以上身份与规则，将 HumanMessage 中的推理过程转换为决策，并通过调用工具提交结构化决策，不要修改或优化推理结论。
  `,

  [PROMPT_NAMES.agentDecisionUser]: `
    推理过程：

    {{reasoning}}

    请调用工具提交你的决策。
  `,

  [PROMPT_NAMES.judgeSystem]:
    '你是一名狼人杀决策质量评估员。请站在玩家做出决策的那一刻、仅凭其当时可见的有限信息，评估该决策是否合理（而非事后以上帝视角倒推）。综合考虑信息利用率、目标选择合理性、与阵营目标的契合度，给出三档结论与 0-100 分。',

  [PROMPT_NAMES.judgeUser]: `
    【玩家身份】
    {{identity}}

    【决策时点可见信息】
    {{contextLines}}

    【待评估决策】
    {{decisionText}}
    {{thinking}}
  `,

  [PROMPT_NAMES.summarizerGlobalSummary]: `
    你是狼人杀对局的记录员。
    请为每位玩家当天的发言生成客观摘要，一句话概括核心内容（30字以内），不带主观评价。

    输出 JSON 格式：
    {
      "summaries": [
        {"day": 1, "seatNo": 3, "summary": "自称预言家，查杀1号，号召投票"},
        {"day": 1, "seatNo": 4, "summary": "对跳预言家，反查杀3号，保1号"}
      ]
    }
  `,

  [PROMPT_NAMES.summarizerJudgmentHuman]: `
    ## 新增的发言（需要判断）

    {{speeches}}

    ## 你的历史判断（最近2天，完整）

    {{recentJudgments}}

    ## 更早的判断（摘要）

    {{olderJudgments}}

    请输出 JSON 格式的分析结果。
  `,

  [PROMPT_NAMES.wolfCoordination]: `
    你是狼人杀游戏的协调者。请分析以下狼人讨论内容，判断他们是否已经达成共识，可以进入投票环节。

    讨论内容：
    {{discussion}}

    判断标准：
    1. 所有狼人都明确表达了同意刀某个目标（例如"同意刀3号位"、"就刀3号位"）
    2. 没有明显的分歧或争议
    3. 讨论已经收敛到一个具体的行动方案

    如果所有狼人都明确同意了一个目标，回答 NO（不需要继续讨论）。
    如果还有分歧或没有达成一致，回答 YES（需要继续讨论）。

    只输出 YES 或 NO，不要解释。
  `,
};

/**
 * 渲染 `{{var}}` 占位符模板
 */
export function renderTemplate(template: string, variables?: Record<string, string>): string {
  if (!variables) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => variables[key] ?? '');
}
