import { Module } from '@nestjs/common';
import { OwnerGuard } from '../../common/auth/owner-context';
import { OwnerAuthGuard } from '../../common/auth/owner-auth.guard';
import { RecentMfaGuard } from '../../common/auth/recent-mfa.guard';
import { ChallengeService } from './challenge.service';
import { OwnerAuthController } from './owner-auth.controller';
import { OwnerAuthService } from './owner-auth.service';

@Module({
  controllers: [OwnerAuthController],
  providers: [
    OwnerAuthService,
    ChallengeService,
    OwnerGuard,
    OwnerAuthGuard,
    RecentMfaGuard,
  ],
  exports: [OwnerGuard, OwnerAuthGuard, RecentMfaGuard],
})
export class OwnerAuthModule {}