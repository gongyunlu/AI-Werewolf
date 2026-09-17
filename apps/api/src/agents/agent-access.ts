import type { PrismaService } from '../prisma/prisma.service';
import type { ModelAccess } from '../llm/model-call.service';
import { decryptAgentSecret } from './agent-secret';

/** 玩家在局接入的来源：端点取自开局快照，密钥读取对应来源的当前值。 */
export interface PlayerAccessSource {
  agentId: string;
  accessBaseUrl: string | null;
  accessUsesDefault?: boolean;
}

/**
 * 解析玩家本局使用的模型接入。
 *
 * 端点不实时读取，Agent 事后改端点不会把在局对局的请求打到新端点上；
 * 密钥不写进快照，同端点轮换后使用最新密钥；端点不匹配时直接失败。
 */
export async function resolvePlayerAccess(
  prisma: PrismaService,
  secretKey: string | undefined,
  source: PlayerAccessSource,
  defaultAccess?: ModelAccess & { apiKey: string },
): Promise<(ModelAccess & { apiKey: string }) | undefined> {
  if (source.accessUsesDefault) {
    if (!defaultAccess || defaultAccess.baseUrl !== source.accessBaseUrl) {
      throw new Error('默认接入端点已变化，无法用当前凭证继续原端点的对局');
    }
    return defaultAccess;
  }
  // 兼容未记录默认端点的历史局；不猜测当时使用的地址。
  if (!source.accessBaseUrl) return undefined;
  const agent = await prisma.agent.findUnique({
    where: { id: source.agentId },
    select: { baseUrl: true, apiKeyCiphertext: true },
  });
  if (!agent?.apiKeyCiphertext || !secretKey) {
    throw new Error(
      `玩家 ${source.agentId} 的开局接入端点已固定，但该 Agent 当前没有可用密钥，无法继续对局`,
    );
  }
  if (agent.baseUrl !== source.accessBaseUrl) {
    throw new Error(`玩家 ${source.agentId} 的 Agent 接入端点已变化，不能将当前密钥发送到原端点`);
  }
  return {
    baseUrl: source.accessBaseUrl,
    apiKey: decryptAgentSecret(agent.apiKeyCiphertext, secretKey),
  };
}
