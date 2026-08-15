import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { Response } from 'express';
import type { SSEMessage, PlayerSnapshot } from '@ai-werewolf/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AbortControllerManager } from '../agent-runtime/abort-controller.manager';
import type { Event } from '../generated/prisma/client';

interface SSEClient {
  response: Response;
  gameId: string;
  connectedAt: Date;
}

@Injectable()
export class BroadcasterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BroadcasterService.name);
  private clients = new Map<string, SSEClient>();
  private heartbeatTimer?: NodeJS.Timeout;
  private playerCache = new Map<string, PlayerSnapshot>(); // 玩家信息缓存

  constructor(
    private prisma: PrismaService,
    private abortManager: AbortControllerManager,
  ) {
    // 事件推送由 EventBusService 调用 broadcast() 方法触发
  }

  onModuleInit() {
    // 启动心跳定时器（30 秒）
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, 30_000);
    this.logger.log('心跳定时器已启动');
  }

  onModuleDestroy() {
    // 清理定时器
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.logger.log('心跳定时器已停止');
    }
  }

  /**
   * 检查指定游戏是否有活跃连接
   */
  hasActiveConnections(gameId: string): boolean {
    return Array.from(this.clients.values()).some((client) => client.gameId === gameId);
  }

  /**
   * 广播 LLM 流式 token
   */
  async broadcastLLMToken(
    gameId: string,
    playerId: string,
    token: string,
    contentType: 'thinking' | 'content',
  ): Promise<void> {
    // 检测：如果没有活跃连接，直接返回（不查库、不推送）
    if (!this.hasActiveConnections(gameId)) {
      return;
    }

    // 优化：缓存玩家信息，避免每个 token 都查库
    const cacheKey = `player:${playerId}`;
    let player = this.playerCache.get(cacheKey);

    if (!player) {
      player = await this.getPlayerSnapshot(playerId);
      this.playerCache.set(cacheKey, player);
    }

    const message: SSEMessage = {
      type: 'llm.token',
      gameId,
      timestamp: new Date().toISOString(),
      player,
      contentType,
      token,
    };

    this.broadcastToGame(gameId, message);
  }

  /**
   * 广播 LLM 完成消息（包含完整 thinking 和最终结果）
   */
  async broadcastLLMComplete(
    gameId: string,
    playerId: string,
    sequence: number,
    speech: string,
    thinking?: string,
  ): Promise<void> {
    // 检测：如果没有活跃连接，直接返回
    if (!this.hasActiveConnections(gameId)) {
      return;
    }

    const player = await this.getPlayerSnapshot(playerId);

    const message: SSEMessage = {
      type: 'llm.complete',
      gameId,
      timestamp: new Date().toISOString(),
      sequence,
      player,
      speech,
      thinking,
    };

    this.broadcastToGame(gameId, message);
  }

  addClient(clientId: string, gameId: string, response: Response): void {
    this.clients.set(clientId, { response, gameId, connectedAt: new Date() });

    // 客户端断开时清理
    response.on('close', () => {
      this.removeClient(clientId);
    });

    this.logger.debug(`客户端 ${clientId} 订阅游戏 ${gameId}，当前连接数: ${this.clients.size}`);
  }

  /**
   * 移除客户端订阅
   */
  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    const gameId = client.gameId;
    this.clients.delete(clientId);
    this.logger.debug(`客户端 ${clientId} 断开，当前连接数: ${this.clients.size}`);

    // 检查该游戏是否还有其他客户端，如果没有则触发中断
    if (!this.hasActiveConnections(gameId)) {
      this.logger.log(`游戏 ${gameId} 的所有客户端已断开，触发 LLM 中断`);
      this.abortManager.abortGame(gameId, 'All SSE connections closed');
    }
  }

  /**
   * 向指定游戏的所有客户端广播事件（供 EventBusService 调用）
   */
  async broadcastGameEvent(event: Event): Promise<void> {
    const targetClients = Array.from(this.clients.entries()).filter(
      ([, client]) => client.gameId === event.gameId,
    );

    if (targetClients.length === 0) {
      this.logger.debug(`游戏 ${event.gameId} 无订阅客户端，跳过广播`);
      return;
    }

    const sseMessage = await this.eventToSSEMessage(event, false);

    // 不支持的事件类型返回 null，跳过广播
    if (!sseMessage) {
      this.logger.debug(`事件类型 ${event.actionType} 不推送到 SSE`);
      return;
    }

    const sseData = this.formatSSE(sseMessage);

    targetClients.forEach(([clientId, client]) => {
      try {
        client.response.write(sseData);
      } catch (err) {
        this.logger.error(`推送失败，移除客户端 ${clientId}`, err);
        this.clients.delete(clientId);
      }
    });

    this.logger.debug(
      `广播事件 ${event.actionType} (seq=${event.sequence}) 到 ${targetClients.length} 个客户端`,
    );
  }

  /**
   * 广播法官播报（不写库，仅实时推送）
   */
  broadcastAnnouncement(
    gameId: string,
    phase: 'night' | 'day_announce' | 'speech' | 'vote' | 'execute',
    day: number,
    text: string,
    subPhase?: string,
  ): void {
    const message: SSEMessage = {
      type: 'game.announcement',
      gameId,
      timestamp: new Date().toISOString(),
      phase,
      day,
      text,
      subPhase,
    };

    this.broadcastToGame(gameId, message);
  }

  /**
   * 广播游戏状态变化
   */
  broadcastStatusChange(
    gameId: string,
    status: 'running' | 'paused' | 'aborted' | 'finished',
  ): void {
    const message: SSEMessage = {
      type: 'game.status',
      gameId,
      timestamp: new Date().toISOString(),
      status,
    };

    this.broadcastToGame(gameId, message);
  }

  /**
   * 发送心跳（防止代理超时）
   */
  sendHeartbeat(): void {
    const now = new Date().toISOString();
    this.clients.forEach(({ gameId, response }) => {
      try {
        const message: SSEMessage = {
          type: 'heartbeat',
          gameId,
          timestamp: now,
        };
        response.write(this.formatSSE(message));
      } catch (err) {
        this.logger.error(`心跳发送失败`, err);
      }
    });
  }

  /**
   * 通用广播方法
   */
  private broadcastToGame(gameId: string, message: SSEMessage): void {
    const targetClients = Array.from(this.clients.entries()).filter(
      ([, client]) => client.gameId === gameId,
    );

    if (targetClients.length === 0) {
      return;
    }

    const sseData = this.formatSSE(message);

    targetClients.forEach(([clientId, client]) => {
      try {
        client.response.write(sseData);
      } catch (err) {
        this.logger.error(`推送失败，移除客户端 ${clientId}`, err);
        this.clients.delete(clientId);
      }
    });
  }

  /**
   * 将 Event 转换为 SSEMessage（查询玩家信息）
   */
  private async eventToSSEMessage(event: Event, isHistorical: boolean): Promise<SSEMessage | null> {
    const content = event.content as Record<string, unknown>;

    switch (event.actionType) {
      case 'player_speech': {
        const actor = await this.getPlayerSnapshot(event.actorId!);
        return {
          type: 'player.spoke',
          gameId: event.gameId,
          timestamp: event.createdAt.toISOString(),
          sequence: event.sequence,
          player: actor,
          speech: content.speech as string,
          thinking: content.thinking as string | undefined,
          isHistorical,
        };
      }

      case 'seer_check': {
        const seer = await this.getPlayerSnapshot(event.actorId!);
        return {
          type: 'night.seer_check',
          gameId: event.gameId,
          timestamp: event.createdAt.toISOString(),
          sequence: event.sequence,
          day: event.day ?? 0,
          seer,
          targetSeatNo: content.targetSeatNo as number,
          result: content.result as 'good' | 'werewolf',
          thinking: content.thinking as string | undefined,
          isHistorical,
        };
      }

      case 'wolf_kill': {
        return {
          type: 'night.wolf_kill',
          gameId: event.gameId,
          timestamp: event.createdAt.toISOString(),
          sequence: event.sequence,
          day: event.day ?? 0,
          targetSeatNo: content.targetSeatNo as number | undefined,
          isHistorical,
        };
      }

      case 'witch_save': {
        const witch = await this.getPlayerSnapshot(event.actorId!);
        return {
          type: 'night.witch_antidote',
          gameId: event.gameId,
          timestamp: event.createdAt.toISOString(),
          sequence: event.sequence,
          day: event.day ?? 0,
          witch,
          targetSeatNo: content.targetSeatNo as number,
          saved: content.saved as boolean,
          thinking: content.thinking as string | undefined,
          isHistorical,
        };
      }

      case 'witch_poison': {
        const witch = await this.getPlayerSnapshot(event.actorId!);
        return {
          type: 'night.witch_poison',
          gameId: event.gameId,
          timestamp: event.createdAt.toISOString(),
          sequence: event.sequence,
          day: event.day ?? 0,
          witch,
          targetSeatNo: content.targetSeatNo as number,
          used: content.used as boolean,
          thinking: content.thinking as string | undefined,
          isHistorical,
        };
      }

      case 'player_vote': {
        const voter = await this.getPlayerSnapshot(event.actorId!);
        const targetSeatNo = content.targetSeatNo as number;
        const target = await this.getPlayerSnapshotBySeatNo(event.gameId, targetSeatNo);
        return {
          type: 'player.voted',
          gameId: event.gameId,
          timestamp: event.createdAt.toISOString(),
          sequence: event.sequence,
          voter,
          target,
          isHistorical,
        };
      }

      case 'death_announcement':
      case 'player_died': {
        const deaths = content.deaths as Array<{ seatNo: number; cause: string }>;
        // 只转换第一个死亡（如果有多个死亡，会有多个 event）
        const death = deaths[0];
        const player = await this.getPlayerSnapshotBySeatNo(event.gameId, death.seatNo);
        return {
          type: 'player.died',
          gameId: event.gameId,
          timestamp: event.createdAt.toISOString(),
          sequence: event.sequence,
          player,
          cause: death.cause as 'night_kill' | 'execution' | 'witch_poison' | 'hunter_shot',
          isHistorical,
        };
      }

      case 'game_ended': {
        return {
          type: 'game.finished',
          gameId: event.gameId,
          timestamp: event.createdAt.toISOString(),
          sequence: event.sequence,
          winnerFaction: content.winnerFaction as 'villager' | 'werewolf' | 'third_party',
          totalDays: content.totalDays as number,
          isHistorical,
        };
      }

      default:
        // 其他事件类型暂不推送（如 wolf_kill、witch_save 等私有事件）
        return null;
    }
  }

  /**
   * 获取玩家快照（by playerId）
   */
  private async getPlayerSnapshot(playerId: string): Promise<PlayerSnapshot> {
    // 优先从缓存读取
    const cacheKey = `player:${playerId}`;
    const cached = this.playerCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const player = await this.prisma.player.findUniqueOrThrow({
      where: { id: playerId },
      include: { agent: true },
    });

    const snapshot: PlayerSnapshot = {
      playerId: player.id,
      seatNo: player.seatNo!,
      agentName: player.displayName,
      role: undefined, // 暂不公开角色
      isAlive: player.deathDay === null,
    };

    // 写入缓存
    this.playerCache.set(cacheKey, snapshot);

    return snapshot;
  }

  /**
   * 获取玩家快照（by gameId + seatNo）
   */
  private async getPlayerSnapshotBySeatNo(gameId: string, seatNo: number): Promise<PlayerSnapshot> {
    // 缓存键包含 gameId 和 seatNo
    const cacheKey = `player:${gameId}:${seatNo}`;
    const cached = this.playerCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const player = await this.prisma.player.findFirstOrThrow({
      where: { gameId, seatNo },
      include: { agent: true },
    });

    const snapshot: PlayerSnapshot = {
      playerId: player.id,
      seatNo: player.seatNo!,
      agentName: player.displayName,
      role: undefined,
      isAlive: player.deathDay === null,
    };

    // 写入两个缓存键（by playerId 和 by gameId+seatNo）
    this.playerCache.set(cacheKey, snapshot);
    this.playerCache.set(`player:${player.id}`, snapshot);

    return snapshot;
  }

  /**
   * 发送连接就绪消息（推送完整玩家列表）
   */
  async sendConnectionReady(gameId: string, response: Response): Promise<void> {
    const players = await this.prisma.player.findMany({
      where: { gameId },
      orderBy: { seatNo: 'asc' },
      include: { agent: true },
    });

    const lastEvent = await this.prisma.event.findFirst({
      where: { gameId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });

    const message: SSEMessage = {
      type: 'connection.ready',
      gameId,
      timestamp: new Date().toISOString(),
      lastSequence: lastEvent?.sequence ?? 0,
      players: players.map((p) => ({
        playerId: p.id,
        seatNo: p.seatNo!,
        agentName: p.displayName,
        role: undefined, // 暂不公开角色
        isAlive: p.deathDay === null,
      })),
    };

    response.write(this.formatSSE(message));
  }

  /**
   * 回放历史事件（断点续传）
   */
  async replayHistory(gameId: string, startSeq: number, response: Response): Promise<void> {
    const historicalEvents = await this.prisma.event.findMany({
      where: {
        gameId,
        sequence: { gt: startSeq },
      },
      orderBy: { sequence: 'asc' },
    });

    // 优化：提取所有需要的 playerId，批量查询玩家信息
    const playerIds = new Set<string>();
    for (const event of historicalEvents) {
      if (event.actorId) playerIds.add(event.actorId);
      const content = event.content as Record<string, unknown>;
      if (content.targetPlayerId && typeof content.targetPlayerId === 'string') {
        playerIds.add(content.targetPlayerId);
      }
    }

    // 批量查询并缓存
    if (playerIds.size > 0) {
      const players = await this.prisma.player.findMany({
        where: { id: { in: Array.from(playerIds) } },
        include: { agent: true },
      });

      for (const player of players) {
        const cacheKey = `player:${player.id}`;
        this.playerCache.set(cacheKey, {
          playerId: player.id,
          seatNo: player.seatNo!,
          agentName: player.displayName,
          role: undefined,
          isAlive: player.deathDay === null,
        });
      }
    }

    for (const event of historicalEvents) {
      const sseMessage = await this.eventToSSEMessage(event, true);
      if (sseMessage) {
        response.write(this.formatSSE(sseMessage));
      }
    }

    // 回放完成后清空缓存
    this.playerCache.clear();

    this.logger.debug(`回放历史事件 ${historicalEvents.length} 条（startSeq=${startSeq}）`);
  }

  /**
   * 格式化为 SSE 格式
   */
  private formatSSE(message: SSEMessage): string {
    let output = 'event: message\n';

    // 带 sequence 的消息添加 id（用于断点续传）
    if ('sequence' in message) {
      output += `id: ${message.sequence}\n`;
    }

    output += `data: ${JSON.stringify(message)}\n\n`;
    return output;
  }
}
