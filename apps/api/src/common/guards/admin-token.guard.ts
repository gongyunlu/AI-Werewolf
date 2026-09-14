import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { Env } from '../../config/env.validation';

export const ADMIN_TOKEN_HEADER = 'x-admin-token';

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 管理写接口的最小鉴权：只比对请求头里的 ADMIN_TOKEN，不做用户体系。
 * 未配置 ADMIN_TOKEN 时一律拒绝，避免部署漏配时写接口静默敞开。
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  constructor(private readonly configService: ConfigService<Env, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.configService.get('ADMIN_TOKEN');
    if (!expected) throw new ServiceUnavailableException('未配置 ADMIN_TOKEN，管理写接口已关闭');
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers[ADMIN_TOKEN_HEADER];
    if (typeof provided !== 'string' || !tokenMatches(provided, expected)) {
      throw new UnauthorizedException(`缺少或错误的 ${ADMIN_TOKEN_HEADER} 请求头`);
    }
    return true;
  }
}
