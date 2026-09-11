import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { recoveryFingerprint } from './recovery-manifest';

jest.mock('node:fs', () => ({ readFileSync: jest.fn(), readdirSync: jest.fn() }));

describe('恢复运行指纹', () => {
  const config = (values: Record<string, unknown> = {}) =>
    ({ get: (key: string) => values[key] }) as ConfigService<Env, true>;
  let changedPath: string;

  beforeEach(() => {
    changedPath = '';
    jest
      .mocked(readdirSync)
      .mockImplementation(() => [{ name: 'runtime.js', isDirectory: () => false }] as any);
    jest
      .mocked(readFileSync)
      .mockImplementation((path) =>
        String(path).includes(changedPath) && changedPath ? 'changed' : 'original',
      );
  });

  it('实际 Skill 目录改变时拒绝复用原发布', () => {
    expect(recoveryFingerprint(config({ SKILLS_DIR: 'release-a' }), {})).not.toBe(
      recoveryFingerprint(config({ SKILLS_DIR: 'release-b' }), {}),
    );
  });

  it('配置的外部 Skill 正文变化时改变指纹', () => {
    const settings = config({ SKILLS_DIR: 'release-a' });
    const before = recoveryFingerprint(settings, {});
    changedPath = 'release-a';
    expect(recoveryFingerprint(settings, {})).not.toBe(before);
  });

  it.each(['memory', 'knowledge'])('%s 实现变化时改变指纹', (directory) => {
    jest
      .mocked(readdirSync)
      .mockImplementation((path) =>
        String(path) === join(__dirname, '..')
          ? ([{ name: directory, isDirectory: () => true }] as any)
          : ([{ name: 'runtime.js', isDirectory: () => false }] as any),
      );
    const before = recoveryFingerprint(config(), {});
    changedPath = join(directory, 'runtime.js');
    expect(recoveryFingerprint(config(), {})).not.toBe(before);
  });

  it.each(['pnpm-lock.yaml', 'index.cjs'])('%s 变化时改变指纹', (file) => {
    const before = recoveryFingerprint(config(), {});
    changedPath = file;
    expect(recoveryFingerprint(config(), {})).not.toBe(before);
  });

  it('相同构建重复计算一致，密钥轮换不影响指纹', () => {
    expect(recoveryFingerprint(config({ ARK_API_KEY: 'a' }), {})).toBe(
      recoveryFingerprint(config({ ARK_API_KEY: 'b' }), {}),
    );
  });
});
