import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AgentsService } from './agents.service';
import { decryptAgentSecret, encryptAgentSecret } from './agent-secret';

const SECRET_KEY = 'a'.repeat(64);

/** 查询层在 omit 密文后交给视图的行 */
const viewRow = {
  id: 'agent-1',
  name: '阿九',
  defaultModelName: 'deepseek-chat',
  memoryLabel: '钱九',
  baseUrl: 'https://deepseek.example/v1',
  apiKeyHint: '1234',
  tag: null,
  isActive: true,
};

/** 落库行的完整形状 */
const baseRow = { ...viewRow, apiKeyCiphertext: 'v1.iv.tag.body' };

/** 传 null 模拟未配置 AGENT_SECRET_KEY 的部署。 */
function createService(secretKey: string | null = SECRET_KEY) {
  const prisma = {
    agent: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  const service = new AgentsService(prisma as never, { get: () => secretKey } as never);
  return { service, prisma };
}

describe('AgentsService 接入配置', () => {
  it('并发备注修改不会撤销已经完成的密钥轮换', async () => {
    const { service, prisma } = createService();
    let row = { ...baseRow, apiKeyCiphertext: encryptAgentSecret('old-key', SECRET_KEY) };
    const original = { ...row };
    let release!: (value: typeof row) => void;
    const pendingRead = new Promise<typeof row>((resolve) => {
      release = resolve;
    });
    prisma.agent.findUnique
      .mockReturnValueOnce(pendingRead)
      .mockImplementation(async () => ({ ...row }));
    prisma.agent.update.mockImplementation(async ({ data }) => {
      row = { ...row, ...data };
      return row;
    });

    const notes = service.updateAgent('agent-1', { notes: '只更新备注' });
    await service.updateAgent('agent-1', { apiKey: 'rotated-key' });
    release(original);
    await notes;

    expect(decryptAgentSecret(row.apiKeyCiphertext, SECRET_KEY)).toBe('rotated-key');
  });

  it('新建时加密落库，返回视图只给掩码', async () => {
    const { service, prisma } = createService();
    // 查询层已 omit 密文，模拟回来的就是带 apiKeyHint、不带 apiKeyCiphertext 的行
    const createdRow = viewRow;
    prisma.agent.create.mockResolvedValue(createdRow);

    const view = await service.createAgent({
      name: '阿九',
      defaultModelName: 'deepseek-chat',
      memoryLabel: '钱九',
      baseUrl: 'https://deepseek.example/v1',
      apiKey: 'sk-abcd1234',
    });

    const { data, omit } = prisma.agent.create.mock.calls[0][0];
    expect(data.apiKeyHint).toBe('1234');
    expect(data.apiKeyCiphertext).not.toContain('sk-abcd1234');
    expect(decryptAgentSecret(data.apiKeyCiphertext, SECRET_KEY)).toBe('sk-abcd1234');
    // 读接口的密文屏蔽靠查询层的 omit，而不是靠返回后手工删字段
    expect(omit).toEqual({ apiKeyCiphertext: true });
    const { apiKeyHint, ...expected } = createdRow;
    expect(apiKeyHint).toBe('1234');
    expect(view).toEqual({ ...expected, hasApiKey: true, apiKeyMasked: '****1234' });
    expect(view).not.toHaveProperty('apiKeyCiphertext');
    expect(view).not.toHaveProperty('apiKeyHint');
  });

  it('未配置 AGENT_SECRET_KEY 时拒绝写入密钥', async () => {
    const { service } = createService(null);
    await expect(
      service.createAgent({
        name: '阿九',
        defaultModelName: 'deepseek-chat',
        memoryLabel: '钱九',
        baseUrl: 'https://deepseek.example/v1',
        apiKey: 'sk-abcd1234',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('未配密钥的 Agent 读出 hasApiKey=false 且没有掩码', async () => {
    const { service, prisma } = createService();
    prisma.agent.findMany.mockResolvedValue([
      { ...baseRow, baseUrl: null, apiKeyCiphertext: null, apiKeyHint: null },
    ]);

    await expect(service.listAgents()).resolves.toEqual([
      expect.objectContaining({ hasApiKey: false, apiKeyMasked: null }),
    ]);
  });

  it('baseUrl 与 apiKey 必须成对，只能整体清除或整体给出', async () => {
    const { service, prisma } = createService();
    // 未接入自带端点的 Agent：三个字段同为 null，这是服务层维护的不变量
    prisma.agent.findUnique.mockResolvedValue({
      ...baseRow,
      baseUrl: null,
      apiKeyCiphertext: null,
      apiKeyHint: null,
    });

    await expect(service.updateAgent('agent-1', { baseUrl: 'https://ds.example' })).rejects.toThrow(
      'baseUrl 与 apiKey 必须同时存在',
    );
    await expect(service.updateAgent('agent-1', { apiKey: 'sk-new-key' })).rejects.toThrow(
      'baseUrl 与 apiKey 必须同时存在',
    );

    prisma.agent.update.mockResolvedValue(baseRow);
    await service.updateAgent('agent-1', {
      baseUrl: 'https://ds.example',
      apiKey: 'sk-new-key',
    });
    const { data } = prisma.agent.update.mock.calls[0][0];
    expect(data.baseUrl).toBe('https://ds.example');
    expect(data.apiKeyHint).toBe('-key');
    expect(decryptAgentSecret(data.apiKeyCiphertext, SECRET_KEY)).toBe('sk-new-key');

    prisma.agent.update.mockResolvedValue({
      ...baseRow,
      baseUrl: null,
      apiKeyCiphertext: null,
      apiKeyHint: null,
    });
    await expect(
      service.updateAgent('agent-1', { baseUrl: null, apiKey: null }),
    ).resolves.toMatchObject({ baseUrl: null, hasApiKey: false });
  });

  it('清空标签时写入 null，避免存进看不见的空字符串', async () => {
    const { service, prisma } = createService();
    prisma.agent.findUnique.mockResolvedValue(baseRow);
    prisma.agent.update.mockResolvedValue({ ...baseRow, tag: null });

    await service.updateAgent('agent-1', { tag: '   ' });

    expect(prisma.agent.update.mock.calls[0][0].data.tag).toBeNull();
  });

  it('Agent 不存在时明确报错', async () => {
    const { service, prisma } = createService();
    prisma.agent.findUnique.mockResolvedValue(null);
    await expect(service.updateAgent('agent-x', { notes: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
