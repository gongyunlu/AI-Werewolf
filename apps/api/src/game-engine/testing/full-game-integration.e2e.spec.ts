import { Test } from '@nestjs/testing';
import { PrismaService } from '@/prisma/prisma.service';
import { PrismaModule } from '@/prisma/prisma.module';
import { AgentRuntimeModule } from '@/agent-runtime/agent-runtime.module';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import { GameEngine } from '../core/game-engine';
import { AgentToolsFactory } from '@/agent-runtime/tools/agent-tools.factory';
import { EventWriterService } from '../events/event-writer.service';
import { Standard6pPreset } from '../presets/game-presets';
import { createGameState, createPlayer } from './test-utils';
import { ConfigModule } from '@nestjs/config';
import { join } from 'node:path';

/**
 * 完整对局集成测试（真实 API 调用版本）
 *
 * 目标：
 * 1. 从头到尾跑通一个完整的游戏流程
 * 2. 使用真实的数据库和 API
 * 3. 验证 createGame -> initialGame -> startGame 等完整流程
 *
 * 注意：
 * - 此测试会调用真实的 LLM API（需要配置 ARK_API_KEY）
 * - 此测试会操作真实的数据库
 * - 运行时间较长（可能需要几分钟）
 * - 在 CI 环境中应该被跳过或使用 mock
 */
describe('完整游戏流程集成测试（真实 API）', () => {
  let prisma: PrismaService;
  let agentRuntime: AgentRuntimeService;
  let toolsFactory: AgentToolsFactory;
  let eventWriter: EventWriterService;
  let gameEngine: GameEngine;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: [
            join(__dirname, '../../../../.env.local'),
            join(__dirname, '../../../../.env'),
          ],
          validate: undefined, // 跳过严格验证，测试环境允许缺少某些变量
          ignoreEnvFile: false,
        }),
        PrismaModule,
        AgentRuntimeModule,
      ],
      providers: [EventWriterService],
    }).compile();

    prisma = moduleRef.get<PrismaService>(PrismaService);
    agentRuntime = moduleRef.get<AgentRuntimeService>(AgentRuntimeService);
    toolsFactory = moduleRef.get<AgentToolsFactory>(AgentToolsFactory);
    eventWriter = moduleRef.get<EventWriterService>(EventWriterService);

    // 等待 AgentRuntimeService 初始化完成
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('完整游戏流程', () => {
    it('从创建游戏到游戏结束跑完整个流程', async () => {
      // 跳过条件：如果没有配置 API key
      if (!process.env.ARK_API_KEY) {
        console.log('⚠️ 跳过真实 API 测试：未配置 ARK_API_KEY');
        return;
      }

      // 1. 创建游戏
      const game = await prisma.game.create({
        data: {
          rulesetId: 'standard6p',
          skillVersion: 'v1',
          status: 'in_progress',
        },
      });

      // 2. 创建玩家配置
      const playerConfigs = [
        { seatNo: 1, role: 'werewolf', faction: 'werewolf', name: '一号' },
        { seatNo: 2, role: 'werewolf', faction: 'werewolf', name: '二号' },
        { seatNo: 3, role: 'seer', faction: 'villager', name: '三号' },
        { seatNo: 4, role: 'witch', faction: 'villager', name: '四号' },
        { seatNo: 5, role: 'villager', faction: 'villager', name: '五号' },
        { seatNo: 6, role: 'villager', faction: 'villager', name: '六号' },
      ] as const;

      // 3. 创建或获取 Agent 并创建玩家
      const players: Array<{
        id: string;
        gameId: string;
        seatNo: number;
        role: string;
        faction: string;
        displayName: string;
        deathDay: number | null;
        deathCause: string | null;
      }> = [];

      for (const config of playerConfigs) {
        let agent = await prisma.agent.findFirst({
          where: { name: config.name },
        });

        if (!agent) {
          agent = await prisma.agent.create({
            data: {
              name: config.name,
              isActive: true,
              defaultModelName: 'doubao-pro-32k',
              memoryLabel: 'default',
            },
          });
        }

        const player = await prisma.player.create({
          data: {
            gameId: game.id,
            agentId: agent.id,
            seatNo: config.seatNo,
            role: config.role,
            faction: config.faction,
            displayName: config.name,
            modelName: agent.defaultModelName,
            memoryLabelSnapshot: agent.memoryLabel,
            deathDay: null,
            deathCause: null,
          },
        });

        players.push({
          id: player.id,
          gameId: player.gameId,
          seatNo: player.seatNo!,
          role: player.role!,
          faction: player.faction!,
          displayName: player.displayName,
          deathDay: null,
          deathCause: null,
        });
      }

      // 4. 创建游戏引擎
      gameEngine = new GameEngine(agentRuntime, toolsFactory, prisma, eventWriter);

      // 5. 准备初始状态
      const playerStates = players.map((p) =>
        createPlayer({
          id: p.id,
          seatNo: p.seatNo,
          role: p.role as any,
          faction: p.faction as any,
        }),
      );

      const initialState = createGameState({
        gameId: game.id,
        players: playerStates,
      });

      console.log(`🎲 游戏开始 (gameId: ${game.id})`);

      // 6. 运行游戏（限制最多 100 轮，避免无限循环）
      const finalState = await gameEngine.run(initialState, 100, undefined, Standard6pPreset);

      // 7. 验证游戏结果
      expect(finalState.isGameOver).toBe(true);
      expect(finalState.winner).toBeDefined();
      expect(['villager', 'werewolf', 'third_party']).toContain(finalState.winner);

      // 验证天数推进
      expect(finalState.currentDay).toBeGreaterThan(1);

      // 验证有玩家死亡
      const deadPlayers = finalState.players.filter((p) => !p.isAlive);
      expect(deadPlayers.length).toBeGreaterThan(0);

      // 8. 验证数据库中的事件记录
      const events = await prisma.event.findMany({
        where: { gameId: game.id },
        orderBy: { sequence: 'asc' },
      });

      expect(events.length).toBeGreaterThan(0);

      // 验证关键事件存在
      const eventTypes = events.map((e) => e.actionType);
      expect(eventTypes).toContain('death_announcement');

      console.log(
        `✅ 游戏结束: ${finalState.winner} 阵营胜利, 共 ${finalState.currentDay} 天, ${events.length} 个事件`,
      );

      // 9. 清理测试数据
      await prisma.event.deleteMany({ where: { gameId: game.id } });
      await prisma.player.deleteMany({ where: { gameId: game.id } });
      await prisma.game.delete({ where: { id: game.id } });
    }, 300000); // 5 分钟超时
  });
});
