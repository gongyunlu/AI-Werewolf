import { Module } from '@nestjs/common';
import { SkillLoaderService } from './skill-loader.service';

@Module({
  controllers: [],
  providers: [SkillLoaderService],
  exports: [SkillLoaderService],
})
export class SkillLoaderModule {}
