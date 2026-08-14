import { Injectable } from '@nestjs/common';
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
 * 个性化摘要结果
 */
export interface PersonalSummary {
  neutralSummary: string; // 客观事实
  judgments: AgentJudgment[]; // 主观判断
  actionPlan: string; // 行动计划
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
  constructor(
    private readonly configService: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly agentJudgmentService: AgentJudgmentService,
  ) {}

  /**
   * 为特定 Agent 生成个性化摘要（Phase 9.6）
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
    // 1. 查询当天的发言
    const speeches = await this.prisma.event.findMany({
      where: {
        gameId,
        day,
        actionType: 'player_speech',
      },
      select: {
        id: true,
        content: true,
        sequence: true,
      },
      orderBy: { sequence: 'asc' },
    });

    if (speeches.length === 0) {
      return {
        neutralSummary: '',
        judgments: [],
        actionPlan: '',
      };
    }

    // 2. 查询该 Agent 的历史判断
    const historyJudgments = await this.agentJudgmentService.getHistoryJudgments(
      agentId,
      gameId,
      day, // 查询当天之前的判断
    );

    // 3. 生成个性化摘要（注入角色视角和私有信息）
    const personalSummary = await this.callLLMWithRolePerspective(
      speeches,
      role,
      privateInfo,
      historyJudgments,
      visiblePlayerSeats,
    );

    // 4. 存储判断结果
    if (personalSummary.judgments.length > 0) {
      await this.agentJudgmentService.saveJudgments(
        agentId,
        gameId,
        day,
        personalSummary.judgments,
      );
    }

    return personalSummary;
  }

  /**
   * 调用 LLM 生成个性化摘要（注入角色视角）
   */
  private async callLLMWithRolePerspective(
    speeches: any[],
    role: string,
    privateInfo: PrivateInfo,
    historyJudgments: AgentJudgment[],
    visiblePlayerSeats: number[],
  ): Promise<PersonalSummary> {
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
      ## 今天的发言\n
      ${this.formatSpeeches(speeches, visiblePlayerSeats)}\n
      ## 你的历史判断\n
      ${this.formatHistoryJudgments(historyJudgments)}\n
      请输出 JSON 格式的分析结果。
    `;

    const messages = [new SystemMessage(systemPrompt), new HumanMessage(humanPrompt)];

    try {
      const parser = new JsonOutputParser<any>();
      const chain = model.pipe(parser);
      const parsed = await chain.invoke(messages);

      // 验证必要字段
      const neutralSummary = parsed.neutralSummary || '';
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
        neutralSummary,
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
          neutralSummary: '',
          judgments: [],
          actionPlan: '',
        };
      }

      // 3. 其他未知错误 → Fail Fast（保险策略）
      throw error;
    }
  }

  /**
   * 获取角色视角的上下文（ 区分一手/二手信息）
   */
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
   * 加载 System Prompt 模板（Phase 9.7.1 - 从 MD 文件加载）
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
      const content = speech.content as any;
      const seatNo = content.seatNo;
      const speechText = content.speech;

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
   * 格式化历史判断
   */
  private formatHistoryJudgments(judgments: AgentJudgment[]): string {
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
        `- ${speaker}号位：信任度${latest.trustScore}%${trend}${latest.suspicious ? '（可疑）' : ''} - ${latest.notes}`,
      );
    }

    return `
      ${lines.join('\n')}\n
      【一致性提醒】\n
      - 如果你对某个玩家的信任度发生大幅变化（>20%），请在 notes 中说明原因\n
      - 保持判断的连贯性，避免前后矛盾
    `;
  }
}
