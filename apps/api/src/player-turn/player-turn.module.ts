import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ModelCallModule } from '../llm/model-call.module';
import { ObservabilityModule } from '../observability/observability.module';
import { PlayerTurnService } from './player-turn.service';

@Module({
  imports: [ConfigModule, ModelCallModule, ObservabilityModule],
  providers: [PlayerTurnService],
  exports: [PlayerTurnService],
})
export class PlayerTurnModule {}
