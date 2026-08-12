import { Module } from '@nestjs/common';
import { SkillLoaderService } from './skill-loader.service';

@Module({
  providers: [SkillLoaderService],
  exports: [SkillLoaderService],
})
export class SkillLoaderModule {}
