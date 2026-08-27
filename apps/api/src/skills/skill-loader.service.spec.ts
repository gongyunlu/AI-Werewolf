import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SkillLoaderService } from './skill-loader.service';

async function createService() {
  const configService = {
    get: jest.fn((key: string) =>
      key === 'SKILLS_DIR' ? path.join(process.cwd(), 'src', 'skills') : undefined,
    ),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [SkillLoaderService, { provide: ConfigService, useValue: configService }],
  }).compile();
  return moduleRef.get(SkillLoaderService);
}

describe('SkillLoaderService', () => {
  it('加载存在的必需 Skill', async () => {
    const service = await createService();

    await expect(service.loadRequiredSkill('roles/werewolf', 'v1')).resolves.toEqual(
      expect.objectContaining({ id: 'roles/werewolf' }),
    );
  });

  it('必需 Skill 缺失时失败', async () => {
    const service = await createService();

    await expect(service.loadRequiredSkill('roles/missing', 'v1')).rejects.toThrow(
      '必需 Skill 不存在或无法读取',
    );
  });

  it('拒绝路径穿越标识', async () => {
    const service = await createService();

    await expect(service.loadSkill('../roles/werewolf', 'v1')).rejects.toThrow('非法 Skill 标识');
  });
});
