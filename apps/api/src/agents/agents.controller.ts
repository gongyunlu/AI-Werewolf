import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AgentsService } from './agents.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';

@ApiTags('agents')
@Controller('agents')
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Post()
  @ApiOperation({ summary: '新建一个 Agent（跨对局持久身份）' })
  create(@Body() dto: CreateAgentDto) {
    return this.agentsService.createAgent(dto);
  }

  @Get()
  @ApiOperation({ summary: '列出 Agent，默认只返活跃 Agent' })
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  list(
    @Query('includeInactive', new DefaultValuePipe(false), ParseBoolPipe)
    includeInactive: boolean,
  ) {
    return this.agentsService.listAgents(includeInactive);
  }

  @Get(':id')
  @ApiOperation({ summary: '按 id 查询 Agent' })
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.agentsService.getAgentById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新 Agent 的模型/记忆标签/备注/启用状态；name 不可改' })
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateAgentDto) {
    return this.agentsService.updateAgent(id, dto);
  }
}
