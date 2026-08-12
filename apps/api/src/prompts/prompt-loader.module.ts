import { Module } from '@nestjs/common';
import { PromptLoaderService } from './prompt-loader.service';

@Module({
  providers: [PromptLoaderService],
  exports: [PromptLoaderService],
})
export class PromptLoaderModule {}
