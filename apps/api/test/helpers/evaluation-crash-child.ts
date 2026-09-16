import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import { EvaluationProjectionService } from '../../src/evaluation/evaluation-projection.service';

it('保存最终判分后立即退出，不投递上报任务', async () => {
  const connectionString = process.env.EVALUATION_TEST_DATABASE!;
  if (!/^\/werewolf_test_[a-f0-9]{32}$/.test(new URL(connectionString).pathname))
    throw new Error('子进程拒绝访问非测试数据库');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('子进程禁止外部请求'));
  const service = new EvaluationProjectionService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
  );
  await service.evaluate(
    process.env.EVALUATION_TEST_GAME!,
    process.env.EVALUATION_TEST_EVENT!,
    'crash-before-enqueue',
    async () => ({ score: 80, verdict: 'good', reasoning: '隔离脚本判分', modelName: 'script' }),
  );
  // 不执行 finally 或模块关闭，交付恢复只能依赖已经提交的数据库记录。
  process.exit(73);
});
