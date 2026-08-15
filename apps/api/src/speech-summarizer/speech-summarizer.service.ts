import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { JsonOutputParser } from '@langchain/core/output_parsers';
import { PrismaService } from '../prisma/prisma.service';
import { AgentJudgmentService, AgentJudgment } from '../agent-judgment/agent-judgment.service';
import type { Env } from '../config/env.validation';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * 私有信息（Agent 独有）
 */
export interface PrivateInfo {
  seatNo: number;
  role: string;
  teammates?: number[]; // 仅狼人
  checkedResults?: Array<{ target: number; result: string }>; // 仅预言家
}

/**
 * 发言记录（完整）
 */
export interface SpeechRecord {
  day: number;
  seatNo: number;
  speech: string; // 完整原文
}

/**
 * 发言摘要（LLM 生成）
 */
export interface SpeechSummary {
  day: number;
  seatNo: number;
  summary: string; // LLM 生成的内容摘要
}

/**
 * 判断摘要（历史压缩）
 */
export interface JudgmentSummary {
  seatNo: number;
  latestTrustScore: number;
  notes: string; // 压缩的判断历史
}

/**
 * 个性化摘要结果
 */
export interface PersonalSummary {
  // 近2天完整发言
  recentSpeeches: SpeechRecord[];

  // 2天以前的发言摘要（LLM 生成）
  olderSpeechesSummary: SpeechSummary[];

  // 我的主观判断（近2天完整）
  recentJudgments: AgentJudgment[];

  // 我的主观判断（2天以前摘要）
  olderJudgmentsSummary: JudgmentSummary[];

  // 行动计划（当天）
  actionPlan: string;
}

/**
 * Speech Summarizer Service
 *
 * 职责：
 * 1. 为每个 Agent 生成个性化的发言摘要
 * 2. 注入角色视角和私有信息
 * 3. 生成主观判断（信任度评分、可疑标记）
 * 4. 存储判断结果用于历史追溯
 */
@Injectable()
export class SpeechSummarizerService {
  private readonly logger = new Logger(SpeechSummarizerService.name);

  constructor(
    private readonly configService: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly agentJudgmentService: AgentJudgmentService,
  ) {}

  /**
   * 为特定 Agent 生成个性化摘要（增量 + 时间窗口分层）
   *
   * @param gameId 对局 ID
   * @param day 天数
   * @param agentId 当前 Agent ID
   * @param role 当前 Agent 角色
   * @param privateInfo 当前 Agent 的私有信息
   * @param visiblePlayerSeats 可见的玩家座位号
   */
  async summarizeForAgent(
    gameId: string,
    day: number,
    agentId: string,
    role: string,
    privateInfo: PrivateInfo,
    visiblePlayerSeats: number[],
  ): Promise<PersonalSummary> {
    this.logger.log(
      `[个性化摘要] Agent ${agentId} (${role}, 座位${privateInfo.seatNo}) - gameId: ${gameId}, day: ${day}`,
    );

    const RECENT_WINDOW = 2; // 最近2天保留完整发言

    // 1. 查询所有历史发言（按天分层）
    const allSpeeches = await this.prisma.event.findMany({
      where: {
        gameId,
        actionType: 'player_speech',
        day: { lte: day }, // 包括当天及之前
      },
      select: {
        id: true,
        day: true,
        content: true,
        sequence: true,
      },
      orderBy: { sequence: 'asc' },
    });

    this.logger.log(`[个性化摘要] 查询到 ${allSpeeches.length} 条历史发言记录`);

    if (allSpeeches.length === 0) {
      return {
        recentSpeeches: [],
        olderSpeechesSummary: [],
        recentJudgments: [],
        olderJudgmentsSummary: [],
        actionPlan: '',
      };
    }

    // 2. 按时间窗口分层发言
    const recentSpeeches: SpeechRecord[] = [];
    const olderSpeeches: any[] = [];

    for (const speech of allSpeeches) {
      const content = speech.content as any;

      // 类型检查
      if (!content || typeof content !== 'object') {
        continue;
      }

      const seatNo = content.seatNo;
      const speechText = content.speech;

      // 验证 seatNo
      if (typeof seatNo !== 'number') {
        continue;
      }

      if (!visiblePlayerSeats.includes(seatNo)) {
        continue;
      }

      const speechDay = speech.day ?? 0;

      if (speechDay >= day - RECENT_WINDOW) {
        // 近2天：保留完整原文
        recentSpeeches.push({
          day: speechDay,
          seatNo,
          speech: speechText || '(未发言)',
        });
      } else {
        // 2天以前：待摘要
        olderSpeeches.push({
          id: speech.id,
          day: speechDay,
          seatNo,
          speech: speechText || '(未发言)',
        });
      }
    }

    this.logger.log(
      `[个性化摘要] 近${RECENT_WINDOW}天发言 ${recentSpeeches.length} 条，更早发言 ${olderSpeeches.length} 条`,
    );

    // 3. 生成历史发言摘要（LLM）
    const olderSpeechesSummary = await this.generateOlderSpeechesSummary(
      olderSpeeches,
      role,
      privateInfo,
    );

    // 4. 查询当天已判断的发言（增量优化）
    const existingJudgments = await this.agentJudgmentService.getJudgmentsByDay(
      agentId,
      gameId,
      day,
    );
    const judgedSpeechIds = new Set(existingJudgments.map((j) => j.speechId));

    // 5. 过滤出当天新增发言（尚未判断的）
    const todayNewSpeeches = allSpeeches.filter((s) => s.day === day && !judgedSpeechIds.has(s.id));

    this.logger.log(
      `[个性化摘要] 当天已有 ${existingJudgments.length} 条判断，新增 ${todayNewSpeeches.length} 条发言`,
    );

    // 6. 查询历史判断（时间窗口分层）
    const { recentJudgments, olderJudgments } = await this.getLayeredHistoryJudgments(
      agentId,
      gameId,
      day,
    );

    // 7. 只对当天新增发言调用 LLM 生成判断
    let newJudgments: AgentJudgment[] = [];
    let actionPlan = '';

    if (todayNewSpeeches.length > 0) {
      const incrementalSummary = await this.callLLMWithRolePerspective(
        todayNewSpeeches,
        role,
        privateInfo,
        [...recentJudgments, ...existingJudgments], // 最近2天 + 当天已有
        olderJudgments, // 更早的（压缩格式）
        visiblePlayerSeats,
      );

      newJudgments = incrementalSummary.judgments;
      actionPlan = incrementalSummary.actionPlan;

      // 存储新增判断
      if (newJudgments.length > 0) {
        await this.agentJudgmentService.saveJudgments(agentId, gameId, day, newJudgments);
        this.logger.log(`[个性化摘要] 已存储 ${newJudgments.length} 条新判断`);
      }
    }

    // 8. 合并判断：近2天完整 + 当天新增
    const allRecentJudgments = [...recentJudgments, ...existingJudgments, ...newJudgments];

    // 9. 生成历史判断摘要
    const olderJudgmentsSummary = this.compressOlderJudgments(olderJudgments);

    return {
      recentSpeeches,
      olderSpeechesSummary,
      recentJudgments: allRecentJudgments,
      olderJudgmentsSummary,
      actionPlan,
    };
  }

  /**
   * 调用 LLM 生成个性化摘要（注入角色视角）
   * 增加 olderJudgments 参数用于时间窗口分层
   */
  private async callLLMWithRolePerspective(
    speeches: any[],
    role: string,
    privateInfo: PrivateInfo,
    recentJudgments: AgentJudgment[], // 最近2天的判断（完整）
    olderJudgments: AgentJudgment[], // 更早的判断（压缩）
    visiblePlayerSeats: number[],
  ): Promise<{ judgments: AgentJudgment[]; actionPlan: string }> {
    const model = new ChatOpenAI({
      apiKey: this.configService.get('ARK_API_KEY'),
      model: this.configService.get('ARK_DEFAULT_MODEL'),
      configuration: { baseURL: this.configService.get('ARK_BASE_URL') },
      temperature: 0.3, // 保持一定创造性，但不过度随机
      maxRetries: 2,
      timeout: 60000,
    });

    const systemPrompt = this.loadSystemPromptTemplate(role, privateInfo);

    const humanPrompt = `
      ## 新增的发言（需要判断）\n
      ${this.formatSpeeches(speeches, visiblePlayerSeats)}\n
      ## 你的历史判断（最近2天，完整）\n
      ${this.formatRecentJudgments(recentJudgments)}\n
      ## 更早的判断（摘要）\n
      ${this.formatOlderJudgments(olderJudgments)}\n
      请输出 JSON 格式的分析结果。
    `;

    const messages = [new SystemMessage(systemPrompt), new HumanMessage(humanPrompt)];

    try {
      const parser = new JsonOutputParser<any>();
      const chain = model.pipe(parser);
      const parsed = await chain.invoke(messages);

      // 验证必要字段
      const judgments = Array.isArray(parsed.judgments) ? parsed.judgments : [];
      const actionPlan = parsed.actionPlan || '';

      // 验证并过滤判断记录
      const validJudgments = judgments
        .filter((j: any) => {
          // 基本字段验证
          if (!j || typeof j !== 'object') return false;
          if (typeof j.speaker !== 'number') return false;
          if (typeof j.trustScore !== 'number') return false;
          if (typeof j.suspicious !== 'boolean') return false;

          if (j.speaker === privateInfo.seatNo) return false;

          // 信任度范围验证
          if (j.trustScore < 0 || j.trustScore > 100) {
            j.trustScore = Math.max(0, Math.min(100, j.trustScore));
          }

          return true;
        })
        .map((j: any) => ({
          speechId: j.speechId || '',
          speaker: j.speaker,
          trustScore: j.trustScore,
          suspicious: j.suspicious,
          notes: (j.notes || '').substring(0, 100), // 限制长度
          relationship: j.relationship || null,
        }));

      return {
        judgments: validJudgments,
        actionPlan,
      };
    } catch (error) {
      // 分层错误处理
      const err = error as any; // TypeScript 类型断言

      // 1. LLM 服务故障 → Fail Fast（让队列重试）
      if (
        err.name === 'APIConnectionError' ||
        err.name === 'TimeoutError' ||
        (err.status && err.status >= 500)
      ) {
        throw new Error(`摘要服务暂时不可用: ${err.message}`, { cause: error });
      }

      // 2. JSON 解析失败 → Silent Fail（LLM 返回格式错误，重试无意义）
      if (error instanceof SyntaxError || err.name === 'JsonParseError') {
        return {
          judgments: [],
          actionPlan: '',
        };
      }

      // 3. 其他未知错误 → Fail Fast（保险策略）
      throw error;
    }
  }

  /**
   * 生成历史发言摘要（2天以前的发言，调用 LLM 生成摘要）
   */
  private async generateOlderSpeechesSummary(
    speeches: Array<{ id: string; day: number; seatNo: number; speech: string }>,
    role: string,
    privateInfo: PrivateInfo,
  ): Promise<SpeechSummary[]> {
    if (speeches.length === 0) {
      return [];
    }

    try {
      const model = new ChatOpenAI({
        apiKey: this.configService.get('ARK_API_KEY'),
        model: this.configService.get('ARK_DEFAULT_MODEL'),
        configuration: { baseURL: this.configService.get('ARK_BASE_URL') },
        temperature: 0.3,
        maxRetries: 2,
        timeout: 60000,
      });

      const systemPrompt = `你是${role}（座位号 ${privateInfo.seatNo}）。
        请为以下历史发言生成简洁摘要，每条发言用一句话概括核心内容（30字以内）。

        输出 JSON 格式：
        {
          "summaries": [
            {"day": 1, "seatNo": 3, "summary": "自称预言家，查杀1号，号召投票"},
            {"day": 1, "seatNo": 4, "summary": "对跳预言家，反查杀3号，保1号"}
          ]
      }`;

      const speechesText = speeches
        .map((s) => `Day ${s.day} - ${s.seatNo}号位：${s.speech.substring(0, 200)}...`)
        .join('\n\n');

      const humanPrompt = `请为以下发言生成摘要：\n\n${speechesText}`;

      const messages = [new SystemMessage(systemPrompt), new HumanMessage(humanPrompt)];

      const parser = new JsonOutputParser<{ summaries: SpeechSummary[] }>();
      const chain = model.pipe(parser);
      const parsed = await chain.invoke(messages);

      return parsed.summaries || [];
    } catch (error) {
      this.logger.warn(
        `[历史发言摘要] LLM 调用失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      // 降级：返回简单摘要
      return speeches.map((s) => ({
        day: s.day,
        seatNo: s.seatNo,
        summary: s.speech.substring(0, 30) + '...',
      }));
    }
  }

  /**
   * 压缩历史判断（2天以前，只保留最新状态）
   */
  private compressOlderJudgments(judgments: AgentJudgment[]): JudgmentSummary[] {
    if (judgments.length === 0) {
      return [];
    }

    // 按玩家分组，只保留最新判断
    const byPlayer = new Map<number, AgentJudgment>();
    for (const j of judgments) {
      byPlayer.set(j.speaker, j); // 后面的会覆盖前面的
    }

    return Array.from(byPlayer.values()).map((j) => ({
      seatNo: j.speaker,
      latestTrustScore: j.trustScore,
      notes: j.notes,
    }));
  }
  /**
   * 获取角色视角的上下文
   */
  private getRoleContext(role: string, privateInfo: PrivateInfo): string {
    try {
      // 确定角色对应的 MD 文件
      const roleFile = ['werewolf', 'seer', 'witch', 'villager'].includes(role)
        ? `${role}.md`
        : 'default.md';

      const mdPath = join(__dirname, '../role-contexts', roleFile);
      let template = readFileSync(mdPath, 'utf-8');

      // 替换变量
      if (role === 'werewolf') {
        const teammates = privateInfo.teammates || [];
        const teammatesStr = teammates.length > 0 ? teammates.join('、') + '号位' : '无队友';
        template = template.replace('{{teammates}}', teammatesStr);
      }

      if (role === 'seer') {
        const checks = privateInfo.checkedResults || [];
        const checkInfo =
          checks.length > 0
            ? checks.map((c) => `${c.target}号是${c.result}`).join('、')
            : '尚未查验';
        template = template.replace('{{checkedResults}}', checkInfo);
      }

      // 替换默认模板的角色名
      template = template.replace('{{role}}', role);

      return template;
    } catch {
      // 降级：返回简单的默认上下文
      return `你是${role}，请根据发言内容给出你的主观判断。`;
    }
  }

  /**
   * 加载 System Prompt 模板（从 MD 文件加载）
   */
  private loadSystemPromptTemplate(role: string, privateInfo: PrivateInfo): string {
    try {
      const templatePath = join(__dirname, '../role-contexts', 'system-prompt-template.md');
      let template = readFileSync(templatePath, 'utf-8');

      // 替换变量
      template = template.replace('{{role}}', role);
      template = template.replace('{{seatNo}}', String(privateInfo.seatNo));
      template = template.replace('{{roleContext}}', this.getRoleContext(role, privateInfo));

      return template;
    } catch {
      // 降级：返回简单的提示词
      return `你是${role}（座位号 ${privateInfo.seatNo}），请根据发言内容给出你的主观判断。`;
    }
  }

  /**
   * 格式化发言列表
   */
  private formatSpeeches(speeches: any[], visiblePlayerSeats: number[]): string {
    const lines: string[] = [];

    for (const speech of speeches) {
      const content = speech.content;

      // 类型检查
      if (!content || typeof content !== 'object') {
        continue;
      }

      const seatNo = content.seatNo;
      const speechText = content.speech;

      // 验证 seatNo
      if (typeof seatNo !== 'number') {
        continue;
      }

      if (!visiblePlayerSeats.includes(seatNo)) {
        continue;
      }

      if (!speechText || speechText.trim() === '') {
        lines.push(`${seatNo}号位：（未发言）`);
      } else {
        lines.push(`${seatNo}号位（事件ID: ${speech.id}）：\n${speechText}\n`);
      }
    }

    return lines.length > 0 ? lines.join('\n---\n') : '（没有可见的发言）';
  }

  /**
   * 格式化历史判断（已废弃，保留用于兼容）
   */
  private formatHistoryJudgments(judgments: AgentJudgment[]): string {
    return this.formatRecentJudgments(judgments);
  }

  /**
   * 格式化最近判断（完整格式，用于最近2天）
   */
  private formatRecentJudgments(judgments: AgentJudgment[]): string {
    if (judgments.length === 0) {
      return '（没有历史判断）';
    }

    // 按玩家分组
    const byPlayer = new Map<number, AgentJudgment[]>();
    for (const j of judgments) {
      if (!byPlayer.has(j.speaker)) {
        byPlayer.set(j.speaker, []);
      }
      byPlayer.get(j.speaker)!.push(j);
    }

    const lines: string[] = [];
    for (const [speaker, playerJudgments] of byPlayer.entries()) {
      const latest = playerJudgments[playerJudgments.length - 1];
      const trend =
        playerJudgments.length > 1
          ? ` (前次: ${playerJudgments[playerJudgments.length - 2].trustScore}%)`
          : '';

      lines.push(
        `- ${speaker}号位（事件ID: ${latest.speechId}）：信任度${latest.trustScore}%${trend}${latest.suspicious ? '（可疑）' : ''} - ${latest.notes}`,
      );
    }

    return `
      ${lines.join('\n')}\n
      【一致性提醒】\n
      - 如果你对某个玩家的信任度发生大幅变化（>20%），请在 notes 中说明原因\n
      - 保持判断的连贯性，避免前后矛盾
    `;
  }

  /**
   * 格式化更早的判断（压缩格式，只保留结论）
   */
  private formatOlderJudgments(judgments: AgentJudgment[]): string {
    if (judgments.length === 0) {
      return '（没有更早的判断）';
    }

    // 按玩家分组，只保留最新判断
    const byPlayer = new Map<number, AgentJudgment>();
    for (const j of judgments) {
      byPlayer.set(j.speaker, j); // 后面的会覆盖前面的
    }

    const lines: string[] = [];
    for (const [speaker, judgment] of byPlayer.entries()) {
      lines.push(
        `- ${speaker}号位（事件ID: ${judgment.speechId}）：信任度${judgment.trustScore}%${judgment.suspicious ? '（可疑）' : ''}`,
      );
    }

    return lines.join('\n');
  }

  /**
   * 查询分层的历史判断（时间窗口分层）
   *
   * @param agentId Agent ID
   * @param gameId 对局 ID
   * @param currentDay 当前天数
   * @returns 最近2天的判断（完整） + 更早的判断（压缩）
   */
  private async getLayeredHistoryJudgments(
    agentId: string,
    gameId: string,
    currentDay: number,
  ): Promise<{ recentJudgments: AgentJudgment[]; olderJudgments: AgentJudgment[] }> {
    const RECENT_WINDOW = 2; // 最近2天保留完整判断

    const allJudgments = await this.agentJudgmentService.getHistoryJudgments(
      agentId,
      gameId,
      currentDay, // 查询当天之前的判断
    );

    // 按 day 字段分层
    const recentJudgments = allJudgments.filter((j) => j.day >= currentDay - RECENT_WINDOW);

    const olderJudgments = allJudgments.filter((j) => j.day < currentDay - RECENT_WINDOW);

    return { recentJudgments, olderJudgments };
  }
}
