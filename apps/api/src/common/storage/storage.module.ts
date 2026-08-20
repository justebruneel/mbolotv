import { Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CloudinaryStorageService } from './cloudinary.storage';
import { LocalStorageService } from './local.storage';
import { S3StorageService } from './s3.storage';
import { StorageService } from './storage.interface';

const storageProvider: Provider = {
  provide: StorageService,
  useFactory: (config: ConfigService) => {
    const driver = config.get<string>('STORAGE_DRIVER', 'local').trim().toLowerCase();
    if (driver === 'cloudinary') return new CloudinaryStorageService(config);
    if (driver === 's3') return new S3StorageService(config);
    return new LocalStorageService(config);
  },
  inject: [ConfigService],
};

@Module({ providers: [storageProvider], exports: [storageProvider] })
export class StorageModule {}
