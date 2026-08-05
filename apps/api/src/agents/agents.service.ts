import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateAgentDto } from './dto/create-agent.dto';
import type { UpdateAgentDto } from './dto/update-agent.dto';

@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  async createAgent(dto: CreateAgentDto) {
    try {
      return await this.prisma.agent.create({ data: dto });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException(`Agent name "${dto.name}" 已存在`);
      }
      throw e;
    }
  }

  listAgents(includeInactive = false) {
    return this.prisma.agent.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getAgentById(id: string) {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new NotFoundException(`Agent ${id} 不存在`);
    }
    return agent;
  }

  async updateAgent(id: string, dto: UpdateAgentDto) {
    await this.getAgentById(id);
    return this.prisma.agent.update({ where: { id }, data: dto });
  }
}
