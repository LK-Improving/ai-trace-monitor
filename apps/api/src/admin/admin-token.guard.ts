import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';

interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

@Injectable()
export class AdminTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const configuredToken = this.config.get<string>('PLATFORM_ADMIN_TOKEN');
    if (typeof configuredToken !== 'string' || configuredToken.length === 0) {
      throw new UnauthorizedException('Unauthorized');
    }

    const request = context.switchToHttp().getRequest<RequestWithHeaders>();
    const authorization = request.headers.authorization;
    const match = typeof authorization === 'string'
      ? /^Bearer ([^\s]+)$/i.exec(authorization)
      : null;
    if (!match) throw new UnauthorizedException('Unauthorized');

    // Hashing both operands first keeps timingSafeEqual's buffers fixed-size.
    const suppliedDigest = digest(match[1]);
    const configuredDigest = digest(configuredToken);
    if (!timingSafeEqual(suppliedDigest, configuredDigest)) {
      throw new UnauthorizedException('Unauthorized');
    }
    return true;
  }
}
