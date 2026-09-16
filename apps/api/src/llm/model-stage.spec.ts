import { ModelCallError } from './model-call-guard';
import { runModelStage, type ModelStageState, type ModelStageStore } from './model-stage';

function setup() {
  const records = new Map<string, ModelStageState>();
  const store: ModelStageStore = {
    update: async (key, change) => {
      const state = change(records.get(key));
      records.set(key, structuredClone(state));
      return structuredClone(state);
    },
  };
  return {
    records,
    store,
    options: { label: 'final', inputHash: 'input', deadline: Date.now() + 10_000, store },
  };
}

it('坏输出、修正请求短暂失败、第三次成功，只允许一次修正且保存成功来源', async () => {
  const { records, options } = setup();
  const call = jest.fn(async (attempt: number, repair?: string) => {
    if (attempt === 1) throw new ModelCallError('invalid_output');
    expect(repair).toContain('未通过校验');
    if (attempt === 2) throw new ModelCallError('transient');
    return { value: '结果', observationId: 'third' };
  });
  await expect(runModelStage({ ...options, call })).resolves.toMatchObject({
    value: '结果',
    observationId: 'third',
  });
  expect(call.mock.calls[1][1]).toBe(call.mock.calls[2][1]);
  await runModelStage({ ...options, call });
  expect(call).toHaveBeenCalledTimes(3);
  expect(records.get('final')?.attempts).toBe(3);
});

it('第二次坏输出即失败，重复消费不会获得新预算', async () => {
  const { options } = setup();
  const call = jest.fn(async () => {
    throw new ModelCallError('invalid_output');
  });
  await expect(runModelStage({ ...options, call })).rejects.toMatchObject({
    code: 'invalid_output',
  });
  await expect(runModelStage({ ...options, call })).rejects.toMatchObject({
    code: 'invalid_output',
  });
  expect(call).toHaveBeenCalledTimes(2);
});

it.each(['truncated_output', 'timeout'] as const)('%s 终止阶段，不自动再请求', async (reason) => {
  const { options } = setup();
  const call = jest.fn(async () => {
    throw new ModelCallError(
      reason === 'timeout' ? 'transient' : 'invalid_output',
      undefined,
      undefined,
      { reason },
    );
  });
  await expect(runModelStage({ ...options, call })).rejects.toThrow();
  expect(call).toHaveBeenCalledTimes(1);
});

it('预占后取消保留计数，恢复只使用剩余额度和原 deadline', async () => {
  const { records, options } = setup();
  const controller = new AbortController();
  await expect(
    runModelStage({
      ...options,
      signal: controller.signal,
      call: async () => {
        controller.abort(new Error('进程停止'));
        throw controller.signal.reason;
      },
    }),
  ).rejects.toThrow('进程停止');
  const call = jest.fn(async () => ({ value: '恢复结果' }));
  await runModelStage({ ...options, deadline: Date.now() + 90_000, call });
  expect(call.mock.calls).toHaveLength(1);
  expect(records.get('final')).toMatchObject({ attempts: 2, deadline: options.deadline });
});

it('存储成功结果失败时不在模型策略内重试', async () => {
  const { options, store } = setup();
  const call = jest.fn(async () => ({ value: 'ok' }));
  const original = store.update;
  store.update = async (key, change) =>
    original(key, (state) => {
      const next = change(state);
      if (next.output) throw new Error('数据库断开');
      return next;
    });
  await expect(runModelStage({ ...options, call })).rejects.toThrow('数据库断开');
  expect(call).toHaveBeenCalledTimes(1);
});

it('结果已保存但取消同时到达时，不把成功结果继续交给调用者', async () => {
  const { options, store, records } = setup();
  const controller = new AbortController();
  const original = store.update;
  store.update = async (label, change) => {
    const state = await original(label, change);
    if (state.output) controller.abort(new Error('保存后取消'));
    return state;
  };
  await expect(
    runModelStage({
      ...options,
      signal: controller.signal,
      call: async () => ({ value: '有效结果' }),
    }),
  ).rejects.toThrow('保存后取消');
  expect(records.get('final')?.output?.value).toBe('有效结果');
});
