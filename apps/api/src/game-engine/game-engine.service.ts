import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Pool } from 'pg';
import { GameEngine } from './game-engine';

/**
 * GameEngineService: 管理游戏引擎实例和 PostgresSaver 生命周期
 *
 * 职责：
 * 1. 应用启动时初始化 PostgresSaver 并建表
 * 2. 提供配置好持久化的 GameEngine 实例
 * 3. 管理连接池生命周期
 */
@Injectable()
export class GameEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GameEngineService.name);
  private pool!: Pool;
  private checkpointer!: PostgresSaver;

  constructor(private readonly configService: ConfigService) {}

  /**
   * 模块初始化时创建 PostgresSaver 并建表
   */
  async onModuleInit() {
    this.logger.log('Initializing PostgresSaver...');

    this.pool = new Pool({
      connectionString: this.configService.get<string>('DATABASE_URL'),
      max: 10,
    });

    this.checkpointer = new PostgresSaver(this.pool);

    try {
      await this.checkpointer.setup();
      this.logger.log('✅ PostgresSaver 初始化完成！');
    } catch (error) {
      this.logger.error('❌ PostgresSaver 初始化失败：', error);
      throw error;
    }
  }

  /**
   * 创建持久化 GameEngine 实例
   *
   * @returns 持久化 GameEngine 实例
   */
  createEngine(): GameEngine {
    if (!this.checkpointer) {
      throw new Error('PostgresSaver not initialized. Did you call onModuleInit()?');
    }

    return new GameEngine(this.checkpointer);
  }

  /**
   * 获取 checkpointer 实例
   */
  getCheckpointer(): PostgresSaver {
    return this.checkpointer;
  }

  /**
   * 清理连接池
   */
  async onModuleDestroy() {
    if (this.pool) {
      await this.pool.end();
      this.logger.log('PostgreSQL connection pool closed');
    }
  }
}
