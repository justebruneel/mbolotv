import { Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LocalStorageService } from './local.storage';
import { S3StorageService } from './s3.storage';
import { StorageService } from './storage.interface';

const storageProvider: Provider = {
  provide: StorageService,
  useFactory: (config: ConfigService) => {
    const driver = config.get<string>('STORAGE_DRIVER', 'local');
    return driver === 's3' ? new S3StorageService(config) : new LocalStorageService(config);
  },
  inject: [ConfigService],
};

@Module({
  providers: [storageProvider],
  exports: [storageProvider],
})
export class StorageModule {}
