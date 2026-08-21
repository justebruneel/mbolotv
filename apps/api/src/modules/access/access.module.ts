import { Module } from '@nestjs/common';
import { OwnerAuthModule } from '../owner-auth/owner-auth.module';
import { AccessController, OwnerAccessController } from './access.controller';
import { AccessGuard } from './access.guard';
import { AccessService } from './access.service';

@Module({
  imports: [OwnerAuthModule],
  controllers: [AccessController, OwnerAccessController],
  providers: [AccessService, AccessGuard],
  exports: [AccessGuard, AccessService],
})
export class AccessModule {}
