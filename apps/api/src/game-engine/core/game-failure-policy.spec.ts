import { Logger } from '@nestjs/common';
import { ModelCallError } from '@/llm/model-call-guard';
import { ExperimentInvalidError } from '@/evaluation/experiment-integrity';
import { failModelCall, settleGameActions, failAfterEffect } from './game-failure-policy';

const context = (overrides: Record<string, unknown> = {}) => overrides as never;

afterEach(() => jest.restoreAllMocks());

it('模型失败记下出错位置后原样上抛，不再产生替代行动', () => {
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const failure = new ModelCallError('transient');

  expect(() => failModelCall(failure, context(), '[发言阶段] 3号位发言出错')).toThrow(failure);
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining('[发言阶段] 3号位发言出错: 模型调用失败: transient'),
  );
});

it('实验局的模型失败判为实验无效', () => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

  expect(() =>
    failModelCall(new ModelCallError('transient'), context({ strictExperiment: true }), '出错'),
  ).toThrow(ExperimentInvalidError);
});

it('主动中止与非模型故障不受实验开关影响', () => {
  const controller = new AbortController();
  controller.abort();
  const aborted = new ModelCallError('transient');
  const bug = new TypeError('context bug');

  expect(() =>
    failModelCall(aborted, context({ signal: controller.signal, strictExperiment: true }), '出错'),
  ).toThrow(aborted);
  expect(() => failModelCall(bug, context({ strictExperiment: true }), '出错')).toThrow(bug);
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
