import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ModelCallService } from './model-call.service';

@Module({ imports: [ConfigModule], providers: [ModelCallService], exports: [ModelCallService] })
export class ModelCallModule {}
