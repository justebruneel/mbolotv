import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.interface';

@Injectable()
export class LocalStorageService implements StorageService {
  private readonly root: string;
  constructor(config: ConfigService) { this.root = resolve(config.get<string>('STORAGE_LOCAL_DIR', './uploads')); }
  private filePath(key: string): string { return join(this.root, key); }
  async put(key: string, body: Buffer): Promise<void> { const file = this.filePath(key); await mkdir(dirname(file), { recursive: true }); await writeFile(file, body); }
  async putStream(key: string, stream: Readable, _contentType: string | undefined, maxBytes: number): Promise<number> {
    const file = this.filePath(key); await mkdir(dirname(file), { recursive: true }); let bytes = 0;
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; callback(bytes > maxBytes ? new Error('Contenu trop volumineux') : null, chunk); } });
    try { await pipeline(stream, limiter, createWriteStream(file)); return bytes; } catch (error) { await rm(file, { force: true }); throw error; }
  }
  async get(key: string): Promise<Buffer | null> { try { return await readFile(this.filePath(key)); } catch { return null; } }
  async delete(key: string): Promise<void> { await rm(this.filePath(key), { force: true }); }
  async signedUrl(key: string): Promise<string> { return `/uploads/${key}`; }
}
