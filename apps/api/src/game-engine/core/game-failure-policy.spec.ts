import { ModelCallError } from '@/llm/model-call-guard';
import { ExperimentInvalidError } from '@/evaluation/experiment-integrity';
import {
  GameFailurePolicy,
  allowModelFallback,
  settleGameActions,
  failAfterEffect,
} from './game-failure-policy';

it('普通局限定降级次数，实验局不允许替代行动', () => {
  const error = new ModelCallError('transient');
  const policy = new GameFailurePolicy(1, false);
  policy.consume(error);
  expect(() => policy.consume(error)).toThrow('降级次数已耗尽');
  expect(() => new GameFailurePolicy(2, true).consume(error)).toThrow(ExperimentInvalidError);
  expect(() => allowModelFallback(new Error('database failed'), {} as never)).toThrow(
    'database failed',
  );
});

it('提交后的实验完整性异常仍能被引擎识别', () => {
  const error = new ExperimentInvalidError('snapshot commit failed');
  expect(() => failAfterEffect(error)).toThrow(error);
  try {
    failAfterEffect(new ModelCallError('transient'));
  } catch (failure) {
    expect(failure).not.toBeInstanceOf(ModelCallError);
  }
});

it('同批某项失败后仍等待其他项退出，再交回 Worker', async () => {
  let finish!: (value: number) => void;
  let settled = false;
  const failure = new Error('commit failed');
  const batch = settleGameActions([
    Promise.reject(failure),
    new Promise<number>((resolve) => {
      finish = resolve;
    }),
  ]);
  const outcome = batch.catch((error) => {
    settled = true;
    return error;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  finish(1);
  await expect(outcome).resolves.toBe(failure);
});
