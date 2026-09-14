import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { MemoryService } from './memory.service';
import { ReplacePersonaStrategyDto } from './dto/replace-persona-strategy.dto';
import { ADMIN_TOKEN_HEADER, AdminTokenGuard } from '../common/guards/admin-token.guard';

@ApiTags('memories')
@Controller('agents/:agentId/memories')
export class AgentMemoryController {
  constructor(private readonly memoryService: MemoryService) {}

  @Get('persona-strategy')
  @ApiOperation({ summary: '读取 Agent 的人设与策略；label 缺省时用该 Agent 当前的记忆集' })
  @ApiQuery({ name: 'label', required: false, description: '记忆集标签，缺省用 Agent.memoryLabel' })
  read(@Param('agentId', new ParseUUIDPipe()) agentId: string, @Query('label') label?: string) {
    return this.memoryService.readPersonaStrategy(agentId, label);
  }

  @Put('persona-strategy')
  @UseGuards(AdminTokenGuard)
  @ApiHeader({ name: ADMIN_TOKEN_HEADER, required: true, description: '管理写接口令牌' })
  @ApiOperation({
    summary: '整批替换 Agent 的人设与策略；旧条目归档保留，不生成 embedding',
  })
  @ApiQuery({ name: 'label', required: false, description: '记忆集标签，缺省用 Agent.memoryLabel' })
  replace(
    @Param('agentId', new ParseUUIDPipe()) agentId: string,
    @Body() dto: ReplacePersonaStrategyDto,
    @Query('label') label?: string,
  ) {
    return this.memoryService.replacePersonaStrategy(agentId, label, dto);
  }
}
