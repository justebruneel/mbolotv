import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { jwtVerify, SignJWT } from 'jose';

export interface SessionJwtPayload {
  purpose: 'owner-session';
  sub: string;
  email: string;
  role: 'OWNER';
  jti: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtService {
  private readonly secret: Uint8Array;

  constructor(config: ConfigService) {
    this.secret = new TextEncoder().encode(config.getOrThrow<string>('JWT_ACCESS_SECRET'));
  }

  async sign(
    payload: Record<string, unknown>,
    ttlSeconds: number,
    issuedAtSeconds?: number,
  ): Promise<string> {
    const signer = new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds);
    if (issuedAtSeconds !== undefined) {
      signer.setIssuedAt(issuedAtSeconds);
    } else {
      signer.setIssuedAt();
    }
    return signer.sign(this.secret);
  }

  async verify<T extends object = Record<string, unknown>>(token: string): Promise<T> {
    try {
      const { payload } = await jwtVerify(token, this.secret);
      return payload as T;
    } catch {
      throw new UnauthorizedException('Jeton invalide ou expiré');
    }
  }
}
