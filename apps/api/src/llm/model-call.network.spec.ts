import { createServer } from 'node:http';
import { Logger } from '@nestjs/common';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { ModelCallService } from './model-call.service';

afterEach(() => jest.restoreAllMocks());

it.each([1, 2])('真实 TCP 连续断开 %s 次时，结构化调用最多发出两次请求', async (failures) => {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  const requests: unknown[] = [];
  // 完整接收请求后主动断开，覆盖供应商可能已经接收请求但客户端未获响应的情况。
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      requests.push(JSON.parse(body));
      if (requests.length <= failures) {
        request.socket.destroy();
        return;
      }
      const chunk = {
        id: 'local-test',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: '{"targetSeatNo":2}' }, finish_reason: 'stop' }],
      };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const config: Record<string, unknown> = {
      ARK_API_KEY: 'isolated-test-key',
      ARK_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    };
    const service = new ModelCallService({ get: (key: string) => config[key] } as never);
    const result = service.structured(
      'local-scripted-model',
      z.object({ targetSeatNo: z.literal(2) }),
      [new HumanMessage('选择 2 号。')],
      () => ({ callbacks: [], metadata: {}, tags: [], runName: 'network-test' }),
    );
    if (failures === 1) {
      await expect(result).resolves.toEqual({ targetSeatNo: 2 });
    } else {
      await expect(result).rejects.toMatchObject({
        code: 'transient',
        details: { errorType: 'APIConnectionError' },
      });
    }
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: 'APIConnectionError',
        causes: expect.arrayContaining([expect.objectContaining({ code: 'UND_ERR_SOCKET' })]),
      }),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
