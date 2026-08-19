import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { JsonOutputParser } from '@langchain/core/output_parsers';
import { PrismaService } from '../prisma/prisma.service';
import { ACTION_TYPES, VISIBILITY_TYPES, ROLES, SEER_CHECK_RESULTS } from '@ai-werewolf/shared';
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
 * 发言摘要（LLM 生成，落 SpeechSummary 表，全局共享）
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
 * 个性化摘要结果（纯读组装，不含 LLM 调用）
 */
export interface PersonalSummary {
  // 近2天完整发言
  recentSpeeches: SpeechRecord[];

  // 2天以前的发言摘要（读 SpeechSummary 表）
  olderSpeechesSummary: SpeechSummary[];

  // 我的主观判断（近2天完整）
  recentJudgments: AgentJudgment[];

  // 我的主观判断（2天以前摘要）
  olderJudgmentsSummary: JudgmentSummary[];
}

/** 近 N 天保留完整发言/判断，更早的压缩成摘要 */
const RECENT_WINDOW = 2;

/**
 * Speech Summarizer Service
 *
 * 职责拆分（步骤②：摘要/判断时机搬迁）：
 * 1. `summarizeForAgent` —— 纯读组装：查近2天原文 + SpeechSummary 摘要 + 历史判断，不调 LLM
 * 2. `generateDaySummaries` —— 白天结束时统一执行：①全局发言摘要 ②逐玩家主观判断
 */
@Injectable()
export class SpeechSummarizerService {
  private readonly logger = new Logger(SpeechSummarizerService.name);
  private readonly templateCache = new Map<string, string>();

  constructor(
    private readonly configService: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly agentJudgmentService: AgentJudgmentService,
  ) {}

  /**
   * 为特定 Agent 组装个性化摘要（纯读，不调 LLM）
   *
   * @param gameId 对局 ID
   * @param day 当前天数
   * @param agentId 当前 Agent ID
   * @param visiblePlayerSeats 可见的玩家座位号
   */
  async summarizeForAgent(
    gameId: string,
    day: number,
    agentId: string,
    visiblePlayerSeats: number[],
  ): Promise<PersonalSummary> {
    // 1. 近2天完整发言（原文）
    const recentSpeeches = await this.loadRecentSpeeches(gameId, day, visiblePlayerSeats);

    // 2. 2天以前的发言摘要（读 SpeechSummary 表）
    const olderSummaryRecords = await this.prisma.speechSummary.findMany({
      where: { gameId, day: { lte: day - RECENT_WINDOW - 1 } },
      orderBy: [{ day: 'asc' }, { seatNo: 'asc' }],
    });
    const olderSpeechesSummary: SpeechSummary[] = olderSummaryRecords.map((s) => ({
      day: s.day,
      seatNo: s.seatNo,
      summary: s.summary,
    }));

    // 3. 历史判断（近2天完整 + 更早压缩）
    const { recentJudgments, olderJudgments } = await this.getLayeredHistoryJudgments(
      agentId,
      gameId,
      day,
    );
    const olderJudgmentsSummary = this.compressOlderJudgments(olderJudgments);

    return {
      recentSpeeches,
      olderSpeechesSummary,
      recentJudgments,
      olderJudgmentsSummary,
    };
  }

  /**
   * 白天结束时统一生成摘要与判断（daySummary 节点调用）
   *
   * @param gameId 对局 ID
   * @param day 刚结束的白天天数
   */
  async generateDaySummaries(gameId: string, day: number): Promise<void> {
    // ① 全局发言摘要（一次，默认模型），为下一天（day+1）的读取做准备
    await this.generateGlobalSpeechSummaries(gameId, day);

    // ② 逐玩家主观判断（N 次，各自模型）
    await this.generatePlayerJudgments(gameId, day);
  }

  /**
   * 查询近2天完整发言（原文）
   */
  private async loadRecentSpeeches(
    gameId: string,
    day: number,
    visiblePlayerSeats: number[],
  ): Promise<SpeechRecord[]> {
    const events = await this.prisma.event.findMany({
      where: {
        gameId,
        actionType: ACTION_TYPES.SPEECH,
        visibility: VISIBILITY_TYPES.PUBLIC, // 只取公开表水发言，隔离狼队夜间商议
        day: { gte: day - RECENT_WINDOW, lte: day },
      },
      select: { day: true, content: true },
      orderBy: { sequence: 'asc' },
    });

    const records: SpeechRecord[] = [];
    for (const e of events) {
      const content = e.content as any;
      if (!content || typeof content !== 'object') continue;
      const seatNo = content.seatNo;
      if (typeof seatNo !== 'number') continue;
      if (!visiblePlayerSeats.includes(seatNo)) continue;
      records.push({
        day: e.day ?? 0,
        seatNo,
        speech: content.speech || '(未发言)',
      });
    }
    return records;
  }

  /**
   * ① 全局发言摘要：为下一天准备 2 天以前的发言摘要，落 SpeechSummary 表
   *
   * 边界：day+1 天读取时，`summarizeForAgent` 读 `day <= (day+1) - 3 = day - 2`，
   * 故此处生成 `speechDay <= day - RECENT_WINDOW` 的发言摘要。
   */
  private async generateGlobalSpeechSummaries(gameId: string, day: number): Promise<void> {
    const boundary = day - RECENT_WINDOW;

    const olderEvents = await this.prisma.event.findMany({
      where: {
        gameId,
        actionType: ACTION_TYPES.SPEECH,
        visibility: VISIBILITY_TYPES.PUBLIC,
        day: { lte: boundary },
      },
      select: { day: true, content: true },
      orderBy: [{ day: 'asc' }, { sequence: 'asc' }],
    });

    if (olderEvents.length === 0) return;

    // 已生成的 (day, seatNo) 集合，用于幂等跳过
    const existing = await this.prisma.speechSummary.findMany({
      where: { gameId, day: { lte: boundary } },
      select: { day: true, seatNo: true },
    });
    const existingKeys = new Set(existing.map((e) => `${e.day}:${e.seatNo}`));

    // 按 (day, seatNo) 分组，过滤已摘要的
    const groups = new Map<string, { day: number; seatNo: number; speeches: string[] }>();
    for (const e of olderEvents) {
      const content = e.content as any;
      if (!content || typeof content !== 'object') continue;
      const seatNo = content.seatNo;
      if (typeof seatNo !== 'number') continue;
      const key = `${e.day ?? 0}:${seatNo}`;
      if (existingKeys.has(key)) continue;
      if (!groups.has(key)) {
        groups.set(key, { day: e.day ?? 0, seatNo, speeches: [] });
      }
      groups.get(key)!.speeches.push(content.speech || '(未发言)');
    }

    if (groups.size === 0) return;

    const summaries = await this.callLLMForSummaries(Array.from(groups.values()));

    for (const s of summaries) {
      await this.prisma.speechSummary.upsert({
        where: { gameId_day_seatNo: { gameId, day: s.day, seatNo: s.seatNo } },
        update: { summary: s.summary },
        create: { gameId, day: s.day, seatNo: s.seatNo, summary: s.summary },
      });
    }
  }

  /**
   * ② 逐玩家主观判断：对当天完整发言，为每个存活玩家生成判断
   */
  private async generatePlayerJudgments(gameId: string, day: number): Promise<void> {
    // 当天全部公开发言
    const todaySpeeches = await this.prisma.event.findMany({
      where: {
        gameId,
        actionType: ACTION_TYPES.SPEECH,
        visibility: VISIBILITY_TYPES.PUBLIC,
        day,
      },
      select: { id: true, content: true },
      orderBy: { sequence: 'asc' },
    });

    if (todaySpeeches.length === 0) return;

    const alivePlayers = await this.prisma.player.findMany({
      where: { gameId, deathDay: null },
      select: { id: true, gameId: true, agentId: true, seatNo: true, role: true, modelName: true },
    });

    const allAliveSeats = alivePlayers.map((p) => p.seatNo).filter((s): s is number => s !== null);

    const results = await Promise.allSettled(
      alivePlayers.map(async (player) => {
        if (player.seatNo === null || player.role === null) return;
        const { id, agentId, seatNo, role, modelName } = player;

        // 当天已判断的发言，跳过已判断
        const existing = await this.agentJudgmentService.getJudgmentsByDay(agentId, gameId, day);
        const judgedIds = new Set(existing.map((j) => j.speechId));
        const newSpeeches = todaySpeeches.filter((s) => !judgedIds.has(s.id));
        if (newSpeeches.length === 0) return;

        const { recentJudgments, olderJudgments } = await this.getLayeredHistoryJudgments(
          agentId,
          gameId,
          day,
        );

        const privateInfo = await this.buildPrivateInfo({ gameId, id, seatNo, role });

        const { judgments } = await this.callLLMWithRolePerspective(
          newSpeeches,
          role,
          privateInfo,
          [...recentJudgments, ...existing], // 最近2天 + 当天已有
          olderJudgments, // 更早的（压缩格式）
          allAliveSeats.filter((s) => s !== seatNo), // 排除自己
          modelName,
        );

        if (judgments.length > 0) {
          await this.agentJudgmentService.saveJudgments(agentId, gameId, day, judgments);
        }
      }),
    );

    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        this.logger.warn(
          `[逐玩家判断] ${alivePlayers[i].seatNo}号位判断生成失败，跳过: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
      }
    });
  }

  /**
   * 构建玩家私有信息（狼人队友 / 预言家查验）
   */
  private async buildPrivateInfo(player: {
    gameId: string;
    id: string;
    seatNo: number;
    role: string;
  }): Promise<PrivateInfo> {
    const privateInfo: PrivateInfo = { seatNo: player.seatNo, role: player.role };

    if (player.role === ROLES.WEREWOLF) {
      const teammates = await this.prisma.player.findMany({
        where: { gameId: player.gameId, role: ROLES.WEREWOLF, id: { not: player.id } },
        select: { seatNo: true },
      });
      privateInfo.teammates = teammates.map((t) => t.seatNo).filter((s): s is number => s !== null);
    }

    if (player.role === ROLES.SEER) {
      const checks = await this.prisma.event.findMany({
        where: {
          gameId: player.gameId,
          actionType: ACTION_TYPES.SEER_CHECK,
          actorId: player.id,
        },
        select: { content: true },
      });
      privateInfo.checkedResults = checks
        .map((e) => e.content as any)
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({
          target: c.targetSeatNo,
          result: c.result === SEER_CHECK_RESULTS.WEREWOLF ? '狼人' : '好人',
        }));
    }

    return privateInfo;
  }

  /**
   * 调用 LLM 生成个性化判断（注入角色视角）
   */
  private async callLLMWithRolePerspective(
    speeches: any[],
    role: string,
    privateInfo: PrivateInfo,
    recentJudgments: AgentJudgment[], // 最近2天的判断（完整）
    olderJudgments: AgentJudgment[], // 更早的判断（压缩）
    visiblePlayerSeats: number[],
    modelName: string,
  ): Promise<{ judgments: AgentJudgment[] }> {
    const model = new ChatOpenAI({
      apiKey: this.configService.get('ARK_API_KEY'),
      model: modelName,
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

      return { judgments: validJudgments };
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
        return { judgments: [] };
      }

      // 3. 其他未知错误 → Fail Fast
      throw error;
    }
  }

  /**
   * 调用 LLM 生成全局发言摘要（中性，与玩家无关）
   */
  private async callLLMForSummaries(
    groups: Array<{ day: number; seatNo: number; speeches: string[] }>,
  ): Promise<SpeechSummary[]> {
    const model = new ChatOpenAI({
      apiKey: this.configService.get('ARK_API_KEY'),
      model: this.configService.get('ARK_DEFAULT_MODEL'),
      configuration: { baseURL: this.configService.get('ARK_BASE_URL') },
      temperature: 0.3,
      maxRetries: 2,
      timeout: 60000,
    });

    const systemPrompt = `你是狼人杀对局的记录员。
        请为每位玩家当天的发言生成客观摘要，一句话概括核心内容（30字以内），不带主观评价。

        输出 JSON 格式：
        {
          "summaries": [
            {"day": 1, "seatNo": 3, "summary": "自称预言家，查杀1号，号召投票"},
            {"day": 1, "seatNo": 4, "summary": "对跳预言家，反查杀3号，保1号"}
          ]
      }`;

    const speechesText = groups
      .map((g) => `Day ${g.day} - ${g.seatNo}号位：${g.speeches.join('；').substring(0, 200)}...`)
      .join('\n\n');

    const humanPrompt = `请为以下发言生成摘要：\n\n${speechesText}`;

    const messages = [new SystemMessage(systemPrompt), new HumanMessage(humanPrompt)];

    try {
      const parser = new JsonOutputParser<{ summaries: SpeechSummary[] }>();
      const chain = model.pipe(parser);
      const parsed = await chain.invoke(messages);
      return parsed.summaries || [];
    } catch (error) {
      this.logger.warn(
        `[全局发言摘要] LLM 调用失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      // 降级：返回简单摘要
      return groups.map((g) => ({
        day: g.day,
        seatNo: g.seatNo,
        summary: g.speeches.join('；').substring(0, 30) + '...',
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
   * 读取模板文件（带内存缓存，避免每个 Agent 每轮同步读盘阻塞事件循环）
   */
  private readTemplate(filePath: string): string {
    const cached = this.templateCache.get(filePath);
    if (cached !== undefined) return cached;
    const content = readFileSync(filePath, 'utf-8');
    this.templateCache.set(filePath, content);
    return content;
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
      let template = this.readTemplate(mdPath);

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
      let template = this.readTemplate(templatePath);

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
