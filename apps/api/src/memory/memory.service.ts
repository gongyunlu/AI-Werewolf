import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { MemoryType } from '@ai-werewolf/shared';
import { Prisma } from '../generated/prisma/client';

export type ActiveMemory = Prisma.MemoryGetPayload<{
  select: {
    id: true;
    type: true;
    title: true;
    content: true;
    importance: true;
  };
}>;

export type RetrieveActiveMemoriesOptions = {
  types?: MemoryType[]; // 指定类型集合，缺省不过滤
  limit?: number; // 每次取多少条，默认 20
};

@Injectable()
export class MemoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 检索指定 agent 的指定 label 的所有 active memory，按 importance 降序、createdAt 升序排序。
   * @param agentId
   * @param label
   * @param opts
   * @returns
   */
  async retrieveActiveMemories(
    agentId: string,
    label: string,
    opts: RetrieveActiveMemoriesOptions = {},
  ): Promise<ActiveMemory[]> {
    const rows = await this.prisma.memory.findMany({
      where: {
        agentId,
        label,
        isActive: true,
        ...(opts.types && opts.types.length > 0 ? { type: { in: opts.types } } : {}),
      },
      orderBy: [{ importance: 'desc' }, { createdAt: 'asc' }],
      take: opts.limit ?? 20,
      select: {
        id: true,
        type: true,
        title: true,
        content: true,
        importance: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      type: r.type as MemoryType,
      title: r.title,
      content: r.content,
      importance: r.importance,
    }));
  }
}
