import { Module } from '@nestjs/common';
import { GameEngineService } from './game-engine.service';

@Module({
  providers: [GameEngineService],
  exports: [GameEngineService],
})
export class GameEngineModule {}
