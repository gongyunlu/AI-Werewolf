import type { Job } from 'bullmq';
import type Redis from 'ioredis';
import type { ModelStageState, ModelStageStore } from './model-stage';

// 只合并当前字段，避免并行阶段或 reviewCompleted 覆盖彼此；阶段 JSON 作为字符串保存。
const SAVE = `
if redis.call('get', KEYS[1] .. ':lock') ~= ARGV[1] then return redis.error_reply('模型任务执行权已失效') end
local raw = redis.call('hget', KEYS[1], 'data')
if not raw then return redis.error_reply('模型任务已不存在') end
local data = cjson.decode(raw)
local states = data.modelStates or {}
if (states[ARGV[2]] or '') ~= ARGV[3] then return redis.error_reply('模型任务阶段被并发改写') end
states[ARGV[2]] = ARGV[4]
data.modelStates = states
data.modelStateVersion = 1
local updated = cjson.encode(data)
redis.call('hset', KEYS[1], 'data', updated)
return updated
`;

/** 预算跟随同一个保留中的队列任务，重新消费不会重新获得次数。 */
export class JobModelStages implements ModelStageStore {
  constructor(
    private readonly redis: Redis,
    private readonly job: Job,
    private readonly token: string,
  ) {}

  async initialize(): Promise<void> {
    await this.value('worker-started', async () => true);
  }

  private async read() {
    const raw = await this.redis.hget(`${this.job.queueQualifiedName}:${this.job.id}`, 'data');
    if (!raw) throw new Error('模型任务已不存在');
    const data = JSON.parse(raw) as {
      modelStateVersion?: number;
      modelStates?: Record<string, string>;
    };
    if (data.modelStateVersion !== undefined && data.modelStateVersion !== 1)
      throw new Error('模型任务阶段版本不受支持');
    if (
      !data.modelStateVersion &&
      (this.job.attemptsMade > 0 || this.job.attemptsStarted > 1 || this.job.stalledCounter > 0)
    )
      throw new Error('旧队列任务缺少历史请求预算，不能作为新阶段重启');
    return data.modelStates ?? {};
  }

  private async save(key: string, previous: string | undefined, value: unknown) {
    const raw = await this.redis.eval(
      SAVE,
      1,
      `${this.job.queueQualifiedName}:${this.job.id}`,
      this.token,
      key,
      previous ?? '',
      JSON.stringify(value),
    );
    // 后续业务检查点仍使用 job.updateData，必须携带最新模型阶段字段。
    this.job.data = JSON.parse(raw as string);
  }

  async update(label: string, change: (state: ModelStageState | undefined) => ModelStageState) {
    const key = `stage/${label}`;
    const previous = (await this.read())[key];
    const next = change(previous ? (JSON.parse(previous) as ModelStageState) : undefined);
    await this.save(key, previous, next);
    return next;
  }

  /** CAS 的每次修订冻结同一份对手建模，恢复仍从第一次修订重放并保持总修订上限。 */
  async value<T>(label: string, create: () => Promise<T>): Promise<T> {
    const key = `input/${label}`;
    const previous = (await this.read())[key];
    const value = previous ? (JSON.parse(previous) as T) : await create();
    await this.save(key, previous, value);
    return value;
  }
}
