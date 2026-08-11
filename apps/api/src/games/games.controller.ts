import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateGameDto } from './dto/create-game.dto';
import { GamesService } from './games.service';

@ApiTags('games')
@Controller('games')
export class GamesController {
  constructor(private readonly gamesService: GamesService) {}

  @Post()
  @ApiOperation({ summary: '创建对局（对局大厅，未分配角色）' })
  create(@Body() dto: CreateGameDto) {
    return this.gamesService.createGame(dto);
  }

  @Post(':id/initialize')
  @ApiOperation({ summary: '初始化对局（随机分配座次与角色）' })
  initialize(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.gamesService.initializeGame(id);
  }

  @Post(':id/start')
  @ApiOperation({ summary: '开始对局（启动游戏引擎）' })
  start(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.gamesService.startGame(id);
  }

  @Get(':id')
  @ApiOperation({ summary: '按 id 查询对局详情，含所有玩家' })
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.gamesService.getGameById(id);
  }
}
