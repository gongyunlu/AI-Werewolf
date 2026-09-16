import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ModelGenerationModule } from '../llm/model-generation.module';
import { ObservabilityModule } from '../observability/observability.module';
import { PlayerTurnService } from './player-turn.service';

@Module({
  imports: [ConfigModule, ModelGenerationModule, ObservabilityModule],
  providers: [PlayerTurnService],
  exports: [PlayerTurnService],
})
export class PlayerTurnModule {}
