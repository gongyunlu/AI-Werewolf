import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

export const EVALUATION_DELIVERY_QUEUE = 'evaluation-delivery';

/** 本地结果兼作上报载荷；队列只调度交付，数据库保留未确认的事实。 */
@Injectable()
export class EvaluationDeliveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EvaluationDeliveryService.name);
  private timer?: ReturnType<typeof setInterval>;
  private scanning?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(EVALUATION_DELIVERY_QUEUE) private readonly queue: Queue<{ runId: string }>,
  ) {}

  async dispatchPending(): Promise<void> {
    let cursor = '';
    for (;;) {
      const runs = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM evaluation_runs
        WHERE id > ${cursor} AND EXISTS (
          SELECT 1 FROM jsonb_each(pending_results) AS entry(key, value)
          WHERE entry.value ? 'result'
            AND NOT (entry.key = ANY(delivered_event_ids::text[]))
        )
        ORDER BY id LIMIT 100`;
      for (const { id: runId } of runs) {
        try {
          const job = await this.queue.getJob(runId);
          if (job) {
            const state = await job.getState();
            // 只重试真实交付失败；这段间隔控制请求频率，不推测平台何时可查询。
            if (state === 'failed' && Date.now() - (job.finishedOn ?? 0) >= 60_000)
              await job.retry();
            continue;
          }
          await this.queue.add(
            'deliver',
            { runId },
            {
              jobId: runId,
              attempts: 1,
              removeOnComplete: true,
              removeOnFail: { age: 86400, count: 1000 },
            },
          );
        } catch (error) {
          this.logger.error({ runId, error }, '评分上报投递失败，保留本地载荷');
        }
      }
      if (runs.length < 100) return;
      cursor = runs.at(-1)!.id;
    }
  }

  private scan() {
    this.scanning ??= this.dispatchPending()
      .catch((error) => this.logger.error({ error }, '无法扫描待上报评分'))
      .finally(() => {
        this.scanning = undefined;
      });
    return this.scanning;
  }

  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      void this.scan();
    }, 30_000);
    this.timer.unref();
    void this.scan();
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.scanning;
  }
}
