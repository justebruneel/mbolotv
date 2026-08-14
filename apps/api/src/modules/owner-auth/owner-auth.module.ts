import { Module } from '@nestjs/common';
import { OwnerGuard } from '../../common/auth/owner-context';
import { OwnerAuthGuard } from '../../common/auth/owner-auth.guard';
import { OwnerAuthController } from './owner-auth.controller';
import { OwnerAuthService } from './owner-auth.service';

@Module({
  controllers: [OwnerAuthController],
  providers: [OwnerAuthService, OwnerGuard, OwnerAuthGuard],
  exports: [OwnerGuard, OwnerAuthGuard],
})
export class OwnerAuthModule {}