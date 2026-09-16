import { Logger } from '@nestjs/common';
import { AIMessageChunk } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { ModelCallService, type ModelAccess } from './model-call.service';
import { ModelGenerationService } from './model-generation.service';
import { testModelCapabilities } from '../testing/model-capabilities.fixture';
import { ModelCallError, ModelCallGuard } from './model-call-guard';

jest.mock('@langchain/openai', () => ({
  OpenAIClient: jest.requireActual('@langchain/openai').OpenAIClient,
  ChatOpenAI: jest.fn(),
}));

const ENV = {
  ARK_BASE_URL: 'https://ark.example/api/v3',
  ARK_API_KEY: 'ark-env-key',
};

const ACCESS: ModelAccess = {
  baseUrl: 'https://deepseek.example/v1',
  apiKey: 'sk-agent-owned-key',
};

const service = (env: Record<string, unknown> = ENV) => {
  const models = [
    'deepseek-chat',
    'doubao-pro',
    'deepseek-flash',
    'minimax-m3',
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'glm-5.2',
  ];
  const capabilities = JSON.stringify(
    [ENV.ARK_BASE_URL, ACCESS.baseUrl].flatMap((url) =>
      JSON.parse(testModelCapabilities(url, models)),
    ),
  );
  const config = {
    get: (key: string) => (key === 'MODEL_CAPABILITIES' ? capabilities : env[key]),
  } as never;
  return new ModelGenerationService(config, new ModelCallService(config), {
    trace: () => ({ callbacks: [], metadata: {}, tags: [], runName: 'test-retry' }),
  } as never);
};

function stubModel(chunks: string[]) {
  return {
    model: 'stub-model',
    stream: async function* () {
      for (const content of chunks) yield { content };
    },
  };
}

describe('模型调用的接入端点', () => {
  afterEach(() => jest.restoreAllMocks());

  it('显式传入自带接入时，请求打到该端点与密钥', async () => {
    jest.mocked(ChatOpenAI).mockReturnValue(stubModel(['你', '好']) as never);

    await expect(
      service().streamText('deepseek-chat', [], undefined, undefined, undefined, ACCESS),
    ).resolves.toBe('你好');

    expect(ChatOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-agent-owned-key',
        model: 'deepseek-chat',
        configuration: { baseURL: 'https://deepseek.example/v1' },
      }),
    );
  });

  it('未传自带接入时回落到环境变量里的默认接入', async () => {
    jest.mocked(ChatOpenAI).mockReturnValue(stubModel(['嗯']) as never);

    await service().streamText('doubao-pro', [], undefined);

    expect(ChatOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'ark-env-key',
        configuration: { baseURL: 'https://ark.example/api/v3' },
      }),
    );
  });

  it('熔断按端点隔离，路由里只有端点与模型名，不含密钥', async () => {
    jest.mocked(ChatOpenAI).mockReturnValue(stubModel(['ok']) as never);
    const run = jest.spyOn(ModelCallGuard.prototype, 'run');

    await service().streamText('deepseek-chat', [], undefined, undefined, undefined, ACCESS);

    expect(run.mock.calls[0][0]).toBe('https://deepseek.example/v1:deepseek-chat');
  });

  it('失败日志里不出现自带密钥', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.mocked(ChatOpenAI).mockReturnValue({
      model: 'deepseek-chat',
      stream: () => {
        throw new ModelCallError('transient', new Error('连接被重置'));
      },
    } as never);

    await expect(
      service().streamText('deepseek-chat', [], undefined, undefined, undefined, ACCESS),
    ).rejects.toBeInstanceOf(ModelCallError);

    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(ACCESS.apiKey);
    expect(JSON.stringify(warn.mock.calls)).toContain('deepseek-chat');
  });
});

describe('结构化输出的协议选择', () => {
  afterEach(() => jest.restoreAllMocks());

  const stubStructured = () => {
    const invoke = jest.fn(async (_messages: readonly { content: unknown }[]) => ({
      parsed: { target: '3号' },
      raw: { content: '{"target":"3号"}', additional_kwargs: {}, response_metadata: {} },
    }));
    return { invoke, withStructuredOutput: jest.fn().mockReturnValue({ invoke }) };
  };

  const callStructured = async (modelName: string, stub: ReturnType<typeof stubStructured>) => {
    jest.mocked(ChatOpenAI).mockReturnValue({ model: 'stub', ...stub } as never);
    return service().structured(modelName, z.object({ target: z.string() }), [], () => ({
      callbacks: [],
      metadata: {},
      tags: [],
      runName: 'test',
    }));
  };

  it.each(['deepseek-flash', 'minimax-m3'])('%s 走 jsonMode', async (modelName) => {
    const stub = stubStructured();

    await expect(callStructured(modelName, stub)).resolves.toEqual({ target: '3号' });
    expect(stub.withStructuredOutput).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: 'jsonMode' }),
    );
  });

  it('jsonMode 的 prompt 里带 json 字样与 Schema，满足 DeepSeek 的硬性要求', async () => {
    const stub = stubStructured();

    await callStructured('deepseek-flash', stub);

    // DeepSeek 对 json_object 模式要求 prompt 必须出现 json，且 schema 只能靠 prompt 传达
    const prompt = String(stub.invoke.mock.calls[0][0].at(-1)?.content);
    expect(prompt).toContain('json');
    expect(prompt).toContain('"target"');
  });

  // 方舟上的 deepseek 系实测支持 json_schema，改走 jsonMode 会白白丢掉服务端约束
  it.each(['deepseek-v4-pro', 'deepseek-v4-flash'])('%s 仍走 jsonSchema', async (modelName) => {
    const stub = stubStructured();

    await callStructured(modelName, stub);

    expect(stub.withStructuredOutput).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: 'jsonSchema' }),
    );
  });

  it('解析在 invoke 内部抛错时，重试带上模型原文而不是重发同一份输入', async () => {
    // LangChain 的解析器在 invoke 内部抛错，模型原文不会随异常返回；
    // 修复前重试消息里没有任何待修正的内容，等于把同样的输入再发一遍。
    const raw = '{"target":"3号","note":"BADOUTPUT"}}';
    const invoke = jest
      .fn()
      .mockImplementationOnce(async (_messages: unknown, options: { callbacks?: unknown[] }) => {
        for (const handler of options.callbacks ?? []) {
          const notify = (handler as { handleLLMNewToken?: (...args: unknown[]) => void })
            .handleLLMNewToken;
          // 必须带 handler 作 this 调用：回调内部依赖自身的 signal 与 progress 字段
          notify?.call(handler, '', {}, 'run-1', undefined, undefined, {
            chunk: { message: new AIMessageChunk({ content: raw }) },
          });
        }
        throw new SyntaxError('Unexpected non-whitespace character after JSON at position 30');
      })
      .mockResolvedValueOnce({
        parsed: { target: '3号' },
        raw: { content: '{"target":"3号"}', additional_kwargs: {}, response_metadata: {} },
      });
    jest.mocked(ChatOpenAI).mockReturnValue({
      model: 'stub',
      withStructuredOutput: jest.fn().mockReturnValue({ invoke }),
    } as never);

    await expect(
      service().structured('deepseek-flash', z.object({ target: z.string() }), [], () => ({
        callbacks: [],
        metadata: {},
        tags: [],
        runName: 'test',
      })),
    ).resolves.toEqual({ target: '3号' });

    expect(invoke).toHaveBeenCalledTimes(2);
    const retryPrompt = invoke.mock.calls[1][0]
      .map((message: { content: unknown }) => String(message.content))
      .join('\n');
    expect(retryPrompt).toContain('以下是上次未通过校验的响应');
    expect(retryPrompt).toContain('BADOUTPUT');
  });
});

describe('发言链路的思维链开关', () => {
  afterEach(() => jest.restoreAllMocks());

  it('发言关闭思维链，省掉与显式思考重复的那份生成', async () => {
    jest.mocked(ChatOpenAI).mockReturnValue(stubModel(['嗯']) as never);

    await service().streamText('deepseek-v4-pro', [], undefined);

    expect(ChatOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ modelKwargs: { thinking: { type: 'disabled' } } }),
    );
  });

  it('glm 不支持该开关，发言时不得传，否则 400 会打断整轮', async () => {
    jest.mocked(ChatOpenAI).mockReturnValue(stubModel(['嗯']) as never);

    await service().streamText('glm-5.2', [], undefined);

    expect(jest.mocked(ChatOpenAI).mock.calls[0][0]).not.toHaveProperty('modelKwargs');
  });

  it('决策链路不关思维链，那里它是模型唯一的思考', async () => {
    const invoke = jest.fn(async () => ({
      parsed: { target: '3号' },
      raw: { content: '{"target":"3号"}', additional_kwargs: {}, response_metadata: {} },
    }));
    jest.mocked(ChatOpenAI).mockReturnValue({
      model: 'stub',
      withStructuredOutput: jest.fn().mockReturnValue({ invoke }),
    } as never);

    await service().structured('deepseek-v4-pro', z.object({ target: z.string() }), [], () => ({
      callbacks: [],
      metadata: {},
      tags: [],
      runName: 'test',
    }));

    expect(jest.mocked(ChatOpenAI).mock.calls[0][0]).not.toHaveProperty('modelKwargs');
  });
});

describe('发言链路的空正文重放', () => {
  afterEach(() => jest.restoreAllMocks());

  /** 按次数返回不同分片，用于模拟「首次空正文、重放成功」这类供应商行为。 */
  type Chunk = { content: string; response_metadata?: { finish_reason: string } };
  function stubRuns(runs: Chunk[][]) {
    return {
      model: 'stub-model',
      stream: (() => {
        let index = 0;
        return async function* () {
          const chunks = runs[Math.min(index, runs.length - 1)];
          index += 1;
          for (const chunk of chunks) yield chunk;
        };
      })(),
    };
  }

  it('首次正文为空时重放同一请求，不再赔掉整轮发言', async () => {
    jest
      .mocked(ChatOpenAI)
      .mockReturnValue(
        stubRuns([[{ content: '' }], [{ content: '正' }, { content: '文' }]]) as never,
      );

    await expect(service().streamText('deepseek-flash', [], undefined)).resolves.toBe('正文');
  });

  it('重放一次仍为空就上抛，不继续重试', async () => {
    const model = stubRuns([[{ content: '' }], [{ content: '  ' }]]);
    jest.mocked(ChatOpenAI).mockReturnValue(model as never);
    const stream = jest.spyOn(model, 'stream');

    await expect(service().streamText('deepseek-flash', [], undefined)).rejects.toMatchObject({
      code: 'invalid_output',
      details: { reason: 'empty_output' },
    });
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it('达到长度上限的截断不重放', async () => {
    const model = stubRuns([[{ content: '', response_metadata: { finish_reason: 'length' } }]]);
    jest.mocked(ChatOpenAI).mockReturnValue(model as never);
    const stream = jest.spyOn(model, 'stream');

    await expect(service().streamText('deepseek-flash', [], undefined)).rejects.toMatchObject({
      details: { reason: 'truncated_output' },
    });
    expect(stream).toHaveBeenCalledTimes(1);
  });
});
