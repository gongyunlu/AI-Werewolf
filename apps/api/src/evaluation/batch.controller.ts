import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BatchService } from './batch.service';
import { BatchRunDto } from './dto/batch-run.dto';

@ApiTags('evaluation')
@Controller('evaluation')
export class BatchController {
  constructor(private readonly batch: BatchService) {}

  @Post('batch')
  @ApiOperation({ summary: '批量跑局（一次投递 count 局到队列）' })
  runBatch(@Body() dto: BatchRunDto) {
    return this.batch.runBatch(dto);
  }
}
