import { Injectable } from '@nestjs/common';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { PrismaService } from '../../prisma/prisma.service';
import { createCastVoteTool } from './cast-vote.tool';
import { createGetAlivePlayersTool } from './get-alive-players.tool';
import type { ToolContext } from './tool-context';

@Injectable()
export class AgentToolsFactory {
  constructor(private readonly prisma: PrismaService) {}

  buildVotingTools(ctx: ToolContext): StructuredToolInterface[] {
    return [createGetAlivePlayersTool(this.prisma, ctx), createCastVoteTool(this.prisma, ctx)];
  }
}
