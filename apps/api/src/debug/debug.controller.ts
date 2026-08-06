import { Controller, Sse } from '@nestjs/common';
import { DebugService } from './debug.service';

@Controller('debug')
export class DebugController {
  constructor(private readonly debugService: DebugService) {}

  @Sse('chat')
  async chat() {
    return this.debugService.chat();
  }
}
