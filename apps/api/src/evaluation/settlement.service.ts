import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GAME_STATUSES, ACTION_TYPES, FACTIONS } from '@ai-werewolf/shared';
import type { Prisma } from '../generated/prisma/client';
import {
  computePlayerMetrics,
  selectKeyEvents,
  type MetricEvent,
  type MetricPlayer,
} from './metrics';

/**
 * 结算服务：对局结束后计算玩家表现指标
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(private readonly prisma: PrismaService) {}

  async settleGame(gameId: string): Promise<void> {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      select: { status: true, winnerFaction: true, totalDays: true },
    });

    if (!game || game.status !== GAME_STATUSES.FINISHED) {
      this.logger.warn({ gameId, status: game?.status }, '对局未结束，跳过结算');
      return;
    }
    if (game.winnerFaction === null || game.totalDays === null) {
      // FINISHED 对局缺胜负/天数即违反数据不变量，必须抛错让调用方同步感知，
      // 否则结算静默跳过、GameSummary 不写，复盘会在后台队列稍后才失败。
      throw new ConflictException(`对局 ${gameId} 缺少胜负/天数数据，无法结算`);
    }

    const [players, events] = await Promise.all([
      this.prisma.player.findMany({
        where: { gameId },
        select: {
          id: true,
          seatNo: true,
          role: true,
          faction: true,
          deathDay: true,
          deathCause: true,
        },
      }),
      this.prisma.event.findMany({
        where: { gameId },
        select: {
          id: true,
          sequence: true,
          day: true,
          actionType: true,
          actorId: true,
          content: true,
        },
        orderBy: { sequence: 'asc' },
      }),
    ]);

    const { totalDays, winnerFaction } = game;

    const metricPlayers: MetricPlayer[] = players;
    const metricEvents: MetricEvent[] = events.map((e) => ({
      id: e.id,
      sequence: e.sequence,
      day: e.day,
      actionType: e.actionType,
      actorId: e.actorId,
      content: (e.content as Record<string, unknown>) ?? {},
    }));

    for (const p of players) {
      const metrics = computePlayerMetrics(
        p,
        metricPlayers,
        metricEvents,
        totalDays,
        winnerFaction,
      );

      // 正常结算时 role/faction 已在 initialize 阶段分配，?? '' 仅为兜底满足非空约束
      // score 不在此写入：评分整批采用时统一写入个人分与 MVP。
      // 在赛后异步落库，结算只负责胜负/存活/投票等客观统计。
      await this.prisma.agentPerformance.upsert({
        where: { gameId_playerId: { gameId, playerId: p.id } },
        update: {
          role: p.role ?? '',
          faction: p.faction ?? '',
          survivalDays: metrics.survivalDays,
          deathCause: metrics.deathCause,
          isWinner: metrics.isWinner,
          voteAccuracy: metrics.voteAccuracy,
          abilityUseCount: metrics.abilityUseCount,
          speechCount: metrics.speechCount,
          speechAvgTokens: metrics.speechAvgTokens,
        },
        create: {
          gameId,
          playerId: p.id,
          role: p.role ?? '',
          faction: p.faction ?? '',
          survivalDays: metrics.survivalDays,
          deathCause: metrics.deathCause,
          isWinner: metrics.isWinner,
          voteAccuracy: metrics.voteAccuracy,
          abilityUseCount: metrics.abilityUseCount,
          speechCount: metrics.speechCount,
          speechAvgTokens: metrics.speechAvgTokens,
        },
      });
    }

    const summaryData = {
      totalDays,
      winnerFaction,
      villagerAliveCount: players.filter(
        (p) => p.faction === FACTIONS.VILLAGER && p.deathDay === null,
      ).length,
      werewolfAliveCount: players.filter(
        (p) => p.faction === FACTIONS.WEREWOLF && p.deathDay === null,
      ).length,
      thirdPartyAliveCount: players.filter(
        (p) => p.faction === FACTIONS.THIRD_PARTY && p.deathDay === null,
      ).length,
      keyEvents: selectKeyEvents(metricEvents) as unknown as Prisma.InputJsonValue,
      totalSpeechCount: metricEvents.filter((e) => e.actionType === ACTION_TYPES.SPEECH).length,
    };

    await this.prisma.gameSummary.upsert({
      where: { gameId },
      update: { ...summaryData, generatedAt: new Date() },
      create: { gameId, ...summaryData },
    });

    this.logger.log({ gameId, winnerFaction, totalDays, players: players.length }, '对局结算完成');
  }
}
