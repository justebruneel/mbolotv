import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service';
import { CryptoService } from './crypto/crypto.service';
import { PasswordService } from './password/password.service';
import { RateLimiterService } from './rate-limit/rate-limiter.service';
import { TotpService } from './totp/totp.service';

@Global()
@Module({
  providers: [CryptoService, PasswordService, TotpService, RateLimiterService, AuditService],
  exports: [CryptoService, PasswordService, TotpService, RateLimiterService, AuditService],
})
export class CommonModule {}