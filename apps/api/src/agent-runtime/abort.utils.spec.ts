import { isAbortError, throwIfAborted } from '../llm/abort.utils';

describe('abort utils', () => {
  it('未取消时不抛异常', () => {
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });

  it('取消后抛出可识别异常', () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => throwIfAborted(controller.signal)).toThrow();
    expect(isAbortError(new Error('request failed'), controller.signal)).toBe(true);
  });
});
