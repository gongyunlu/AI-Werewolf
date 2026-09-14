import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Env } from '../config/env.validation';
import { encryptAgentSecret } from './agent-secret';
import type { CreateAgentDto } from './dto/create-agent.dto';
import type { UpdateAgentDto } from './dto/update-agent.dto';

/** 读接口一律不带密文；密钥相关信息只以 hasApiKey / apiKeyMasked 暴露。 */
export const AGENT_PUBLIC_OMIT = { apiKeyCiphertext: true } as const;

/** 对局响应只需要 Agent 的展示字段，连密钥尾号提示也不带。 */
export const AGENT_GAME_OMIT = { apiKeyCiphertext: true, apiKeyHint: true } as const;

/** 去掉密钥字段，换成「是否已配置」与可辨认的掩码。 */
function toAgentView(agent: { apiKeyHint: string | null; [key: string]: unknown }) {
  const { apiKeyHint, ...rest } = agent;
  return {
    ...rest,
    hasApiKey: apiKeyHint !== null,
    apiKeyMasked: apiKeyHint === null ? null : `****${apiKeyHint}`,
  };
}

/** 空字符串按「未填写」处理，避免标签里存进看不见的空值。 */
function normalizeTag(tag: string | null | undefined): string | null {
  if (tag === undefined) return null;
  const trimmed = tag?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  /** 读取 agents 表原始行（含密文），只供解密与写路径内部使用。 */
  private async findRaw(id: string) {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) throw new NotFoundException(`Agent ${id} 不存在`);
    return agent;
  }

  private encrypt(apiKey: string): { apiKeyCiphertext: string; apiKeyHint: string } {
    const secretKey = this.configService.get('AGENT_SECRET_KEY');
    if (!secretKey) {
      throw new BadRequestException('未配置 AGENT_SECRET_KEY，无法保存 Agent 自带密钥');
    }
    return {
      apiKeyCiphertext: encryptAgentSecret(apiKey, secretKey),
      apiKeyHint: apiKey.slice(-4),
    };
  }

  async createAgent(dto: CreateAgentDto) {
    const key = dto.apiKey ? this.encrypt(dto.apiKey) : null;
    try {
      const agent = await this.prisma.agent.create({
        data: {
          name: dto.name,
          defaultModelName: dto.defaultModelName,
          memoryLabel: dto.memoryLabel,
          notes: dto.notes,
          baseUrl: dto.baseUrl ?? null,
          apiKeyCiphertext: key?.apiKeyCiphertext ?? null,
          apiKeyHint: key?.apiKeyHint ?? null,
          tag: normalizeTag(dto.tag),
        },
        omit: AGENT_PUBLIC_OMIT,
      });
      return toAgentView(agent);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException(`Agent name "${dto.name}" 已存在`);
      }
      throw e;
    }
  }

  async listAgents(includeInactive = false) {
    const agents = await this.prisma.agent.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { createdAt: 'asc' },
      omit: AGENT_PUBLIC_OMIT,
    });
    return agents.map(toAgentView);
  }

  async getAgentById(id: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      omit: AGENT_PUBLIC_OMIT,
    });
    if (!agent) throw new NotFoundException(`Agent ${id} 不存在`);
    return toAgentView(agent);
  }

  async updateAgent(id: string, dto: UpdateAgentDto) {
    const existing = await this.findRaw(id);

    // 字段缺省=保持原值，null=清除，有值=覆盖；成对约束按合并后的结果校验。
    const baseUrl = dto.baseUrl === undefined ? existing.baseUrl : dto.baseUrl;
    const key =
      dto.apiKey === undefined
        ? { apiKeyCiphertext: existing.apiKeyCiphertext, apiKeyHint: existing.apiKeyHint }
        : dto.apiKey === null
          ? { apiKeyCiphertext: null, apiKeyHint: null }
          : this.encrypt(dto.apiKey);
    if (Boolean(baseUrl) !== Boolean(key.apiKeyCiphertext)) {
      throw new BadRequestException(
        'baseUrl 与 apiKey 必须同时存在；只改其中一个时请把另一个一并给出，或都清空回落到默认接入',
      );
    }

    const agent = await this.prisma.agent.update({
      where: { id },
      data: {
        ...(dto.defaultModelName !== undefined ? { defaultModelName: dto.defaultModelName } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.tag !== undefined ? { tag: normalizeTag(dto.tag) } : {}),
        ...(dto.baseUrl !== undefined ? { baseUrl } : {}),
        ...(dto.apiKey !== undefined ? key : {}),
      },
      omit: AGENT_PUBLIC_OMIT,
    });
    return toAgentView(agent);
  }
}
