import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Agent 判断数据类型
 */
export interface AgentJudgment {
  speechId: string;
  speaker: number;
  trustScore: number; // 0-100
  suspicious: boolean;
  notes: string;
  relationship?: string | null; // 关系标识（teammate/checked_good/checked_wolf/silver）
}

/**
 * Agent 判断服务
 *
 * 负责存储和查询 Agent 对发言的主观判断
 */
@Injectable()
export class AgentJudgmentService {
  private readonly VALID_RELATIONSHIPS = ['teammate', 'checked_good', 'checked_wolf', 'silver'];

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 保存 Agent 的判断
   */
  async saveJudgments(
    agentId: string,
    gameId: string,
    day: number,
    judgments: AgentJudgment[],
  ): Promise<void> {
    if (judgments.length === 0) {
      return;
    }

    // 验证 relationship 值
    for (const j of judgments) {
      if (j.relationship && !this.VALID_RELATIONSHIPS.includes(j.relationship)) {
        throw new Error(`Invalid relationship value: ${j.relationship}`);
      }
    }

    await this.prisma.agentJudgment.createMany({
      data: judgments.map((j) => ({
        agentId,
        gameId,
        speechEventId: j.speechId,
        day,
        speakerSeatNo: j.speaker,
        trustScore: j.trustScore,
        suspicious: j.suspicious,
        notes: j.notes,
        relationship: j.relationship || null,
      })),
      skipDuplicates: true,
    });
  }

  /**
   * 查询 Agent 的历史判断
   *
   * @param agentId Agent ID
   * @param gameId 对局 ID
   * @param beforeDay 可选，查询指定天数之前的判断
   */
  async getHistoryJudgments(
    agentId: string,
    gameId: string,
    beforeDay?: number,
  ): Promise<AgentJudgment[]> {
    const where: any = { agentId, gameId };
    if (beforeDay !== undefined) {
      where.day = { lt: beforeDay };
    }

    const records = await this.prisma.agentJudgment.findMany({
      where,
      orderBy: { day: 'asc' },
    });

    return records.map((r) => ({
      speechId: r.speechEventId,
      speaker: r.speakerSeatNo,
      trustScore: r.trustScore,
      suspicious: r.suspicious,
      notes: r.notes || '',
      relationship: r.relationship || null,
    }));
  }

  /**
   * 查询 Agent 对特定玩家的最新信任度
   *
   * @param agentId Agent ID
   * @param gameId 对局 ID
   * @param targetSeatNo 目标玩家座位号
   */
  async getLatestTrustScore(
    agentId: string,
    gameId: string,
    targetSeatNo: number,
  ): Promise<number | null> {
    const judgment = await this.prisma.agentJudgment.findFirst({
      where: {
        agentId,
        gameId,
        speakerSeatNo: targetSeatNo,
      },
      orderBy: { day: 'desc' },
      select: { trustScore: true },
    });

    return judgment?.trustScore ?? null;
  }
}
