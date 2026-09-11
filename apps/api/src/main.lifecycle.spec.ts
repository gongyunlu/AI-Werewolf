jest.mock('@nestjs/core', () => ({ NestFactory: { create: jest.fn() } }));
jest.mock('@nestjs/config', () => ({ ConfigService: { name: 'ConfigService' } }));
jest.mock('@nestjs/swagger', () => ({
  DocumentBuilder: class {
    setTitle() {
      return this;
    }
    setDescription() {
      return this;
    }
    setVersion() {
      return this;
    }
    build() {
      return {};
    }
  },
  SwaggerModule: { createDocument: jest.fn(), setup: jest.fn() },
}));
jest.mock('nestjs-zod', () => ({
  ZodValidationPipe: jest.fn(),
  cleanupOpenApiDoc: jest.fn(),
}));
jest.mock('nestjs-pino', () => ({ Logger: { name: 'Logger' } }));
jest.mock('./app.module', () => ({ AppModule: { name: 'AppModule' } }));
jest.mock('./common/filters/all-exceptions.filter', () => ({ AllExceptionsFilter: jest.fn() }));
jest.mock('./game-queue/game-worker.service', () => ({
  GameWorkerService: { name: 'GameWorkerService' },
}));
jest.mock('./evaluation/judge.worker', () => ({
  JudgeWorkerService: { name: 'JudgeWorkerService' },
}));
jest.mock('./reflection/reflection.worker', () => ({
  ReflectionWorkerService: { name: 'ReflectionWorkerService' },
}));
jest.mock('./memory-maintenance/maintenance.worker', () => ({
  MaintenanceWorkerService: { name: 'MaintenanceWorkerService' },
}));
jest.mock('./game-executor/game-executor.service', () => ({
  GameExecutorService: { name: 'GameExecutorService' },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function createHarness() {
  const workerNames = [
    'GameWorkerService',
    'JudgeWorkerService',
    'ReflectionWorkerService',
    'MaintenanceWorkerService',
  ];
  const workers = workerNames.map(() => ({
    pause: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  }));
  const executor = { interruptActiveGames: jest.fn().mockResolvedValue(undefined) };
  const app = {
    get: jest.fn((token: { name: string }) => {
      const workerIndex = workerNames.indexOf(token.name);
      if (workerIndex >= 0) return { worker: workers[workerIndex] };
      if (token.name === 'GameExecutorService') return executor;
      if (token.name === 'ConfigService') return { get: () => 0 };
      return {};
    }),
    useLogger: jest.fn(),
    setGlobalPrefix: jest.fn(),
    useGlobalPipes: jest.fn(),
    useGlobalFilters: jest.fn(),
    enableShutdownHooks: jest.fn(),
    listen: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const handlers = new Map<string, () => Promise<void>>();
  const ready = deferred();
  jest
    .spyOn(process, 'once')
    .mockImplementation((event: string | symbol, listener: (...args: any[]) => void) => {
      if (event === 'SIGINT' || event === 'SIGTERM')
        handlers.set(event, listener as () => Promise<void>);
      if (event === 'SIGTERM') ready.resolve();
      return process;
    });
  const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const { NestFactory } = jest.requireMock<{ NestFactory: { create: jest.Mock } }>('@nestjs/core');
  NestFactory.create.mockResolvedValue(app);

  jest.requireActual('./main');
  await ready.promise;

  return { app, workers, executor, handlers, exit };
}

describe('API shutdown lifecycle', () => {
  beforeEach(() => {
    jest.resetModules();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('所有 worker 停止领取后才中断对局，worker 全部结束后才关闭依赖', async () => {
    const { app, workers, executor, handlers, exit } = await createHarness();
    const pauseGate = deferred();
    const closeGate = deferred();
    const closingStarted = deferred();
    workers[0].pause.mockReturnValue(pauseGate.promise);
    workers[0].close.mockImplementation(() => {
      closingStarted.resolve();
      return closeGate.promise;
    });

    const shuttingDown = handlers.get('SIGTERM')!();

    workers.forEach((worker) => expect(worker.pause).toHaveBeenCalledWith(true));
    expect(executor.interruptActiveGames).not.toHaveBeenCalled();
    expect(app.close).not.toHaveBeenCalled();
    pauseGate.resolve();
    await closingStarted.promise;
    expect(executor.interruptActiveGames).toHaveBeenCalledTimes(1);
    workers.forEach((worker) => expect(worker.close).toHaveBeenCalledTimes(1));
    expect(app.close).not.toHaveBeenCalled();
    closeGate.resolve();
    await shuttingDown;

    expect(app.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(app.enableShutdownHooks).not.toHaveBeenCalled();
  });

  it('重复关闭信号不再次清理任务或关闭资源', async () => {
    const { app, workers, executor, handlers } = await createHarness();

    await Promise.all([handlers.get('SIGINT')!(), handlers.get('SIGTERM')!()]);

    expect(executor.interruptActiveGames).toHaveBeenCalledTimes(1);
    workers.forEach((worker) => expect(worker.close).toHaveBeenCalledTimes(1));
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('持久化中断失败时仍等待 worker 结束，再关闭应用资源', async () => {
    const { app, workers, executor, handlers } = await createHarness();
    const error = new Error('database unavailable during interrupt');
    executor.interruptActiveGames.mockRejectedValue(error);

    await expect(handlers.get('SIGTERM')!()).rejects.toBe(error);

    workers.forEach((worker) => {
      expect(worker.close).toHaveBeenCalledTimes(1);
      expect(worker.close.mock.invocationCallOrder[0]).toBeLessThan(
        app.close.mock.invocationCallOrder[0],
      );
    });
    expect(app.close).toHaveBeenCalledTimes(1);
  });
});
