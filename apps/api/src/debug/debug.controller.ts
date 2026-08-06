import { Controller, Post, Sse, Body } from '@nestjs/common';
import { DebugService } from './debug.service';
import { AgentRuntimeService } from '../agent-runtime/agent-runtime.service';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

const TestVotingAgentSchema = z.object({
  gameId: z.string().uuid({}),
  currentPlayerId: z.string().uuid({}),
  scenarioPrompt: z
    .string()
    .optional()
    .default('当前是投票阶段，请调用 get_alive_players 查看存活玩家，然后投票给其中一人。'),
  maxIterations: z.coerce.number().int().positive().optional().default(6),
});

class TestVotingAgentDto extends createZodDto(TestVotingAgentSchema) {}

@Controller('debug')
export class DebugController {
  constructor(
    private readonly debugService: DebugService,
    private readonly agentRuntimeService: AgentRuntimeService,
  ) {}

  @Sse('chat')
  async chat() {
    return this.debugService.chat();
  }

  @Post('test-voting-agent')
  async testVotingAgent(@Body() dto: TestVotingAgentDto) {
    const result = await this.agentRuntimeService.runVotingAgent({
      ctx: {
        gameId: dto.gameId,
        currentPlayerId: dto.currentPlayerId,
      },
      scenarioPrompt: dto.scenarioPrompt,
      maxIterations: dto.maxIterations,
    });
    return result;
  }
}
