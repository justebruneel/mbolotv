import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.interface';

@Injectable()
export class LocalStorageService implements StorageService {
  private readonly root: string;

  constructor(config: ConfigService) {
    this.root = resolve(config.get<string>('STORAGE_LOCAL_DIR', './uploads'));
  }

  private filePath(key: string): string {
    return join(this.root, key);
  }

  async put(key: string, body: Buffer, _contentType?: string): Promise<void> {
    const file = this.filePath(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.filePath(key));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.filePath(key), { force: true });
  }

  async signedUrl(key: string, _expiresInSeconds: number): Promise<string> {
    return `/uploads/${key}`;
  }
}
