import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service';
import { CryptoService } from './crypto/crypto.service';
import { JwtService } from './jwt/jwt.service';
import { PasswordService } from './password/password.service';
import { RateLimiterService } from './rate-limit/rate-limiter.service';

@Global()
@Module({
  providers: [CryptoService, PasswordService, RateLimiterService, AuditService, JwtService],
  exports: [CryptoService, PasswordService, RateLimiterService, AuditService, JwtService],
})
export class CommonModule {}