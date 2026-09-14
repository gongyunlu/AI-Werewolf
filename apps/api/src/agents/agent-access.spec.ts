import type { PrismaService } from '../prisma/prisma.service';
import { encryptAgentSecret } from './agent-secret';
import { resolvePlayerAccess, type PlayerAccessSource } from './agent-access';

const SECRET_KEY = 'c'.repeat(64);
const API_KEY = 'sk-agent-owned';
const BASE_URL = 'https://api.deepseek.com';

function buildPrisma(ciphertext: string | null, baseUrl = BASE_URL) {
  const findUnique = jest.fn().mockResolvedValue({ apiKeyCiphertext: ciphertext, baseUrl });
  return { findUnique, prisma: { agent: { findUnique } } as unknown as PrismaService };
}

const source = (accessBaseUrl: string | null): PlayerAccessSource => ({
  agentId: 'agent-1',
  accessBaseUrl,
});

describe('玩家本局接入的解析', () => {
  it('默认接入保持开局端点，同时使用当前默认密钥', async () => {
    const { prisma, findUnique } = buildPrisma(null);
    const defaultAccess = { baseUrl: BASE_URL, apiKey: 'rotated-default-key' };

    await expect(
      resolvePlayerAccess(
        prisma,
        SECRET_KEY,
        {
          ...source(BASE_URL),
          accessUsesDefault: true,
        },
        defaultAccess,
      ),
    ).resolves.toEqual(defaultAccess);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('默认端点改变时拒绝向旧端点发送当前默认密钥', async () => {
    const { prisma } = buildPrisma(null);

    await expect(
      resolvePlayerAccess(
        prisma,
        SECRET_KEY,
        {
          ...source(BASE_URL),
          accessUsesDefault: true,
        },
        { baseUrl: 'https://relay.example', apiKey: 'new-provider-key' },
      ),
    ).rejects.toThrow(/默认接入端点已变化/);
  });

  it('Agent 切换端点后拒绝把新密钥发送到旧局端点', async () => {
    const { prisma } = buildPrisma(
      encryptAgentSecret('new-provider-key', SECRET_KEY),
      'https://relay.example',
    );
    await expect(resolvePlayerAccess(prisma, SECRET_KEY, source(BASE_URL))).rejects.toThrow(
      /端点已变化/,
    );
  });

  it('同一端点轮换密钥后，旧局直接使用最新密钥', async () => {
    const { prisma } = buildPrisma(encryptAgentSecret('rotated-key', SECRET_KEY));
    await expect(resolvePlayerAccess(prisma, SECRET_KEY, source(BASE_URL))).resolves.toEqual({
      baseUrl: BASE_URL,
      apiKey: 'rotated-key',
    });
  });

  it('有开局端点时解密 Agent 密钥，端点取自快照', async () => {
    const { prisma } = buildPrisma(encryptAgentSecret(API_KEY, SECRET_KEY));

    await expect(resolvePlayerAccess(prisma, SECRET_KEY, source(BASE_URL))).resolves.toEqual({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
    });
  });

  it('没有开局端点的玩家走默认接入，不额外查 Agent', async () => {
    const { findUnique, prisma } = buildPrisma(encryptAgentSecret(API_KEY, SECRET_KEY));

    await expect(resolvePlayerAccess(prisma, SECRET_KEY, source(null))).resolves.toBeUndefined();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('端点已固定但 Agent 没有密钥时抛错，不静默回落默认接入', async () => {
    const { prisma } = buildPrisma(null);

    await expect(resolvePlayerAccess(prisma, SECRET_KEY, source(BASE_URL))).rejects.toThrow(
      /没有可用密钥/,
    );
  });
});
