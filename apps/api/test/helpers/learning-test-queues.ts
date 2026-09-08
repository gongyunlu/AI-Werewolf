import { randomUUID } from 'node:crypto';
import { FlowProducer, Queue, QueueEvents, Worker } from 'bullmq';
import Redis from 'ioredis';
import { MEMORY_MAINTENANCE_QUEUE } from '../../src/memory-maintenance/memory-maintenance.service';
import { REFLECT_QUEUE_NAME } from '../../src/reflection/reflection-queue.service';

export async function withLearningTestQueues(
  task: (resources: {
    maintenanceQueue: Queue;
    reflectionQueue: Queue;
    maintenanceEvents: QueueEvents;
    reflectionEvents: QueueEvents;
    flow: FlowProducer;
    connection: Redis;
    prefix: string;
    workers: Worker[];
  }) => Promise<void>,
) {
  if (!process.env.REDIS_URL) throw new Error('队列集成测试需要 REDIS_URL');
  const prefix = 'learning_test_' + randomUUID().replaceAll('-', '');
  if (!/^learning_test_[a-f0-9]{32}$/.test(prefix)) throw new Error('拒绝使用非测试队列前缀');
  const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const options = { connection, prefix };
  const maintenanceQueue = new Queue(MEMORY_MAINTENANCE_QUEUE, options);
  const reflectionQueue = new Queue(REFLECT_QUEUE_NAME, options);
  const maintenanceEvents = new QueueEvents(MEMORY_MAINTENANCE_QUEUE, options);
  const reflectionEvents = new QueueEvents(REFLECT_QUEUE_NAME, options);
  const flow = new FlowProducer(options);
  const workers: Worker[] = [];
  try {
    await Promise.all([maintenanceEvents.waitUntilReady(), reflectionEvents.waitUntilReady()]);
    await task({
      maintenanceQueue,
      reflectionQueue,
      maintenanceEvents,
      reflectionEvents,
      flow,
      connection,
      prefix,
      workers,
    });
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    await Promise.all([flow.close(), maintenanceEvents.close(), reflectionEvents.close()]);
    await maintenanceQueue.obliterate({ force: true });
    await reflectionQueue.obliterate({ force: true });
    await Promise.all([maintenanceQueue.close(), reflectionQueue.close()]);
    await connection.quit();
  }
}
