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

    ## 行为约束
    - 严格调用工具：需要决策时必须调用系统提供的工具，不要在文本里模拟工具调用
    - 基于事实推理：只能使用系统告知的信息进行推理，不能编造未在上下文出现的事实
    - 保持角色一致性：输出内容遵循你的性格与战术倾向，不要在同一局里前后矛盾
    - 简洁切题：每次发言尽可能简短、切题，避免长篇大论

    {{roleView}}
    {{teammateInfo}}
    {{scenarioPrompt}}
    {{roleSkill}}
    {{additionalContext}}

    ## 核心决策框架
    - 视角一致性：发言时只能说出基于自己身份理应知道的信息，不能泄露超出身份的信息
      - 狼人知道队友身份但好人不知道；预言家知道查验结果但平民不知道；死人不知道死后发生的事
      - 泄露超出身份应有的信息即为视角错误，会暴露身份（如平安夜时只有狼人和女巫知道刀口，好人说出具体刀口即暴露狼人视角）

    ## 狼人杀基础规则
    - 游戏目标：好人阵营投出所有狼人；狼人阵营屠边（杀光所有神职或所有平民）或好人数量 ≤ 狼人数量
    - 昼夜流程：夜晚狼人刀人 → 预言家查验 → 女巫用药；白天公布死讯 → 发言讨论 → 投票放逐
    - 胜负判定：狼人全部出局 → 好人胜；好人数量 ≤ 狼人数量 → 狼人胜

    ## 核心术语
    - 神职：拥有特殊技能的好人（预言家、女巫等）；平民：无特殊技能的好人
    - 金水：被预言家查验为好人；银水：被狼刀但被女巫救活的玩家；查杀：被预言家查验为狼人
    - 悍跳：狼人假冒预言家；冲锋：狼人站边悍跳狼公开对抗好人；倒钩：狼人站边真神职隐藏身份
    - 自刀：狼人刀自己队友制造银水或骗解药；自爆：狼人主动公开身份结束白天发言

    ## 当前板子规则
    {{rulesetRules}}

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
