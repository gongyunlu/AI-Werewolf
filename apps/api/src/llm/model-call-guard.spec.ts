import { ModelCallError, ModelCallGuard } from './model-call-guard';

const unavailable = () => Object.assign(new Error('unavailable'), { status: 503 });

describe('ModelCallGuard', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('只熔断故障路由，冷却后只允许一次探测', async () => {
    const guard = new ModelCallGuard({ minSamples: 2, cooldownMs: 1000 });
    const fail = jest.fn().mockRejectedValue(unavailable());
    await expect(guard.run('a', fail)).rejects.toMatchObject({ code: 'transient' });
    await expect(guard.run('a', fail)).rejects.toMatchObject({ code: 'transient' });
    await expect(guard.run('a', fail)).rejects.toMatchObject({ code: 'circuit_open' });
    expect(fail).toHaveBeenCalledTimes(2);
    await expect(guard.run('b', async () => 'ok')).resolves.toBe('ok');
    await jest.advanceTimersByTimeAsync(1001);
    let resolve!: (value: string) => void;
    const probe = guard.run(
      'a',
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    await expect(guard.run('a', fail)).rejects.toMatchObject({ code: 'circuit_open' });
    resolve('restored');
    await expect(probe).resolves.toBe('restored');
    await expect(guard.run('a', async () => 'ok')).resolves.toBe('ok');
  });

  it('取消和配置错误不消耗依赖故障额度', async () => {
    const guard = new ModelCallGuard({ minSamples: 1 });
    const controller = new AbortController();
    const call = guard.run('a', () => new Promise(() => {}), controller.signal);
    const rejected = expect(call).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    const badConfig = Object.assign(new Error('unauthorized'), { status: 401 });
    await expect(
      guard.run('a', async () => {
        throw badConfig;
      }),
    ).rejects.toBe(badConfig);
    await expect(guard.run('a', async () => 'ok')).resolves.toBe('ok');
  });

  it('调用超时会取消请求，并将路由计为失败', async () => {
    const guard = new ModelCallGuard({ timeoutMs: 100, minSamples: 1 });
    let received: AbortSignal | undefined;
    const call = guard.run('a', (signal) => {
      received = signal;
      return new Promise(() => {});
    });
    const rejected = expect(call).rejects.toBeInstanceOf(ModelCallError);
    await jest.advanceTimersByTimeAsync(100);
    await rejected;
    expect(received?.aborted).toBe(true);
    await expect(guard.run('a', async () => 'no')).rejects.toMatchObject({ code: 'circuit_open' });
  });

  it('遵守 Retry-After，而不是立刻再请求被限流的路由', async () => {
    const guard = new ModelCallGuard({ cooldownMs: 1000 });
    const error = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: new Headers({ 'retry-after': '10' }),
    });
    await expect(
      guard.run('a', async () => {
        throw error;
      }),
    ).rejects.toMatchObject({ code: 'transient' });
    await jest.advanceTimersByTimeAsync(1001);
    await expect(guard.run('a', async () => 'no')).rejects.toMatchObject({ code: 'circuit_open' });
    await jest.advanceTimersByTimeAsync(9000);
    await expect(guard.run('a', async () => 'ok')).resolves.toBe('ok');
  });

  it('单次输出解析错误不会被当成网络故障熔断', async () => {
    const guard = new ModelCallGuard({ minSamples: 1 });
    const error = Object.assign(new Error('parse'), { lc_error_code: 'OUTPUT_PARSING_FAILURE' });
    await expect(
      guard.run('a', async () => {
        throw error;
      }),
    ).rejects.toMatchObject({ code: 'invalid_output' });
    await expect(guard.run('a', async () => 'ok')).resolves.toBe('ok');
  });

  it('并发请求后到的 Retry-After 仍能延长已打开的熔断窗口', async () => {
    const guard = new ModelCallGuard({ minSamples: 1, cooldownMs: 1000 });
    let rejectFirst!: (error: Error) => void;
    let rejectSecond!: (error: Error) => void;
    const first = guard.run(
      'a',
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    const second = guard.run(
      'a',
      () =>
        new Promise((_resolve, reject) => {
          rejectSecond = reject;
        }),
    );
    const settled = Promise.allSettled([first, second]);
    rejectFirst(unavailable());
    await jest.advanceTimersByTimeAsync(0);
    rejectSecond(
      Object.assign(new Error('rate limited'), {
        status: 429,
        headers: new Headers({ 'retry-after': '10' }),
      }),
    );
    await settled;
    await jest.advanceTimersByTimeAsync(1001);
    await expect(guard.run('a', async () => 'too soon')).rejects.toMatchObject({
      code: 'circuit_open',
    });
    await jest.advanceTimersByTimeAsync(9000);
    await expect(guard.run('a', async () => 'ok')).resolves.toBe('ok');
  });

  it('流式调用一直没有有效片段时按首包期限退出', async () => {
    const guard = new ModelCallGuard({ firstChunkTimeoutMs: 100, streamTimeoutMs: 1000 });
    const result = guard.run('a', () => new Promise(() => {}), undefined, 'stream');
    const rejected = expect(result).rejects.toMatchObject({
      code: 'transient',
      details: { timeoutPhase: 'first_chunk', timeoutMs: 100 },
    });
    await jest.advanceTimersByTimeAsync(100);
    await rejected;
    expect(jest.getTimerCount()).toBe(0);
  });

  it('首包后切换到停滞期限，每次进展重新计时', async () => {
    const guard = new ModelCallGuard({
      firstChunkTimeoutMs: 100,
      streamIdleTimeoutMs: 40,
      streamTimeoutMs: 1000,
    });
    let progress!: () => void;
    const result = guard.run(
      'a',
      (_signal, report) => {
        progress = report;
        return new Promise(() => {});
      },
      undefined,
      'stream',
    );
    const rejected = expect(result).rejects.toMatchObject({
      details: { timeoutPhase: 'idle', timeoutMs: 40, elapsedMs: 150 },
    });
    await jest.advanceTimersByTimeAsync(80);
    progress();
    await jest.advanceTimersByTimeAsync(30);
    progress();
    await jest.advanceTimersByTimeAsync(40);
    await rejected;
    expect(jest.getTimerCount()).toBe(0);
  });

  it('持续有进展也不能无限延长流式总期限', async () => {
    const guard = new ModelCallGuard({
      firstChunkTimeoutMs: 100,
      streamIdleTimeoutMs: 40,
      streamTimeoutMs: 150,
    });
    let progress!: () => void;
    const result = guard.run(
      'a',
      (_signal, report) => {
        progress = report;
        return new Promise(() => {});
      },
      undefined,
      'stream',
    );
    const rejected = expect(result).rejects.toMatchObject({
      details: { timeoutPhase: 'total', timeoutMs: 150, elapsedMs: 150 },
    });
    for (let i = 0; i < 4; i++) {
      await jest.advanceTimersByTimeAsync(30);
      progress();
    }
    await jest.advanceTimersByTimeAsync(30);
    await rejected;
    progress();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('整局取消优先于流式期限，迟到的进展不会留下定时器或触发熔断', async () => {
    const guard = new ModelCallGuard({ minSamples: 1 });
    const parent = new AbortController();
    let progress!: () => void;
    const result = guard.run(
      'a',
      (_signal, report) => {
        progress = report;
        return new Promise(() => {});
      },
      parent.signal,
      'stream',
    );
    progress();
    const reason = new DOMException('Game deadline', 'TimeoutError');
    const rejected = expect(result).rejects.toBe(reason);
    parent.abort(reason);
    await rejected;
    progress();
    expect(jest.getTimerCount()).toBe(0);
    await expect(guard.run('a', async () => 'ok')).resolves.toBe('ok');
  });

  it('流式成功返回后不遗留首包、停滞和总期限定时器', async () => {
    const guard = new ModelCallGuard();
    let progress!: () => void;
    await expect(
      guard.run(
        'a',
        async (_signal, report) => {
          progress = report;
          report();
          return 'ok';
        },
        undefined,
        'stream',
      ),
    ).resolves.toBe('ok');
    progress();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('并发调用的有效片段不会刷新其他调用的首包期限', async () => {
    const guard = new ModelCallGuard({ firstChunkTimeoutMs: 100 });
    const waiting = guard.run('a', () => new Promise(() => {}), undefined, 'stream');
    const rejected = expect(waiting).rejects.toMatchObject({
      details: { timeoutPhase: 'first_chunk' },
    });
    await jest.advanceTimersByTimeAsync(80);
    await guard.run(
      'a',
      async (_signal, progress) => {
        progress();
        return 'ok';
      },
      undefined,
      'stream',
    );
    await jest.advanceTimersByTimeAsync(20);
    await rejected;
    expect(jest.getTimerCount()).toBe(0);
  });
});
