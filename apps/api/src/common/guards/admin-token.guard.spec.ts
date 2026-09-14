import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ADMIN_TOKEN_HEADER, AdminTokenGuard } from './admin-token.guard';

const TOKEN = 'admin-token-for-test';

function contextWith(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

const guard = (token: string | undefined) => new AdminTokenGuard({ get: () => token } as never);

describe('管理写接口鉴权', () => {
  it('未配置 ADMIN_TOKEN 时关闭写接口，而不是放行', () => {
    expect(() =>
      guard(undefined).canActivate(contextWith({ [ADMIN_TOKEN_HEADER]: TOKEN })),
    ).toThrow(ServiceUnavailableException);
  });

  it.each([
    ['缺少请求头', {}],
    ['令牌错误', { [ADMIN_TOKEN_HEADER]: 'wrong-token-value' }],
    ['令牌长度不同', { [ADMIN_TOKEN_HEADER]: `${TOKEN}x` }],
    ['请求头重复导致非字符串', { [ADMIN_TOKEN_HEADER]: [TOKEN, TOKEN] }],
  ])('%s 时拒绝', (_label, headers) => {
    expect(() => guard(TOKEN).canActivate(contextWith(headers))).toThrow(UnauthorizedException);
  });

  it('令牌正确时放行', () => {
    expect(guard(TOKEN).canActivate(contextWith({ [ADMIN_TOKEN_HEADER]: TOKEN }))).toBe(true);
  });
});
