import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GameRecoveryModule } from '../game-recovery/game-recovery.module';
import { ObservabilityModule } from '../observability/observability.module';
import { ModelCallModule } from './model-call.module';
import { ModelGenerationService } from './model-generation.service';

@Global()
@Module({
  imports: [ConfigModule, ModelCallModule, ObservabilityModule, GameRecoveryModule],
  providers: [ModelGenerationService],
  exports: [ModelGenerationService],
})
export class ModelGenerationModule {}
