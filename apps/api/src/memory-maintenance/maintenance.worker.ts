import { ModelGenerationService } from '../llm/model-generation.service';
import { JobModelStages } from '../llm/job-model-stages';
import { RedisService } from '../redis/redis.service';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MEMORY_MAINTENANCE_QUEUE, MemoryMaintenanceService } from './memory-maintenance.service';

interface MaintenanceJobData {
  gameId: string;
}

/**
 * 记忆维护 Worker：消费每局结束后的维护任务。
 *
 * concurrency=1 是正确性要求而非性能取舍：固化会跨局软删除同一 agent 的 lesson，
 * 串行执行保证「软删除源 + 写 strategy」事务天然幂等，无需额外并发锁。
 */
@Processor(MEMORY_MAINTENANCE_QUEUE, { concurrency: 1 })
export class MaintenanceWorkerService extends WorkerHost {
  private readonly logger = new Logger(MaintenanceWorkerService.name);

  constructor(
    private readonly maintenanceService: MemoryMaintenanceService,
    private readonly generations: ModelGenerationService,
    private readonly redis: RedisService,
  ) {
    super();
  }

  async process(job: Job<MaintenanceJobData>, token?: string): Promise<void> {
    token ??= job.token;
    if (!token) throw new Error('模型任务缺少 Worker 执行令牌');
    return this.generations.withJob(new JobModelStages(this.redis, job, token), () =>
      this.consume(job),
    );
  }

  private async consume(job: Job<MaintenanceJobData>): Promise<void> {
    const { gameId } = job.data;
    try {
      const result = await this.maintenanceService.runForGame(gameId);
      this.logger.log({ gameId, ...result }, '记忆维护完成');
    } catch (error) {
      this.logger.error(
        { gameId, err: error instanceof Error ? error.message : String(error) },
        '记忆维护失败，交由队列重试',
      );
      throw error;
    }
  }
}
