import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RulesetsService } from './rulesets.service';

@ApiTags('rulesets')
@Controller('rulesets')
export class RulesetsController {
  constructor(private readonly rulesetsService: RulesetsService) {}

  @Get()
  @ApiOperation({ summary: '列出所有可用的规则集' })
  list() {
    return this.rulesetsService.listRulesets();
  }

  @Get(':id')
  @ApiOperation({ summary: '按 id 查询规则集详情' })
  findOne(@Param('id') id: string) {
    return this.rulesetsService.getRulesetById(id);
  }
}
