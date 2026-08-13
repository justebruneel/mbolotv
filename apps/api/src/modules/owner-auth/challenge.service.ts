import { createHmac } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface ChallengePayload {
  sub: string;
  purpose: string;
  exp: number;
}

@Injectable()
export class ChallengeService {
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
  }

  sign(payload: ChallengePayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  verify(token: string): ChallengePayload {
    const [body, signature] = token.split('.');
    if (!body || !signature) throw new UnauthorizedException('Challenge invalide');
    const expected = createHmac('sha256', this.secret).update(body).digest('base64url');
    if (signature !== expected) throw new UnauthorizedException('Challenge invalide');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ChallengePayload;
    if (payload.exp < Date.now() / 1000) throw new UnauthorizedException('Challenge expiré');
    return payload;
  }
}