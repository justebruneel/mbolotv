import { Module } from '@nestjs/common';
import { OwnerAuthModule } from '../owner-auth/owner-auth.module';
import { OwnerConsoleController } from './owner-console.controller';

@Module({
  imports: [OwnerAuthModule],
  controllers: [OwnerConsoleController],
})
export class OwnerConsoleModule {}