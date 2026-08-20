import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { StorageService } from './storage.interface';

@Injectable()
export class CloudinaryStorageService implements StorageService {
  private readonly cloudName: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly folder: string;

  constructor(config: ConfigService) {
    this.cloudName = config.getOrThrow<string>('CLOUDINARY_CLOUD_NAME');
    this.apiKey = config.getOrThrow<string>('CLOUDINARY_API_KEY');
    this.apiSecret = config.getOrThrow<string>('CLOUDINARY_API_SECRET');
    this.folder = (config.get<string>('CLOUDINARY_FOLDER', 'mbolo-tv') ?? 'mbolo-tv').replace(/^\/+|\/+$/g, '');
  }

  async put(key: string, body: Buffer, contentType?: string): Promise<void> {
    await this.upload(key, body, contentType);
  }

  async putStream(key: string, stream: Readable, contentType: string | undefined, maxBytes: number): Promise<number> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) throw new Error('Contenu trop volumineux');
      chunks.push(buffer);
    }
    await this.upload(key, Buffer.concat(chunks), contentType);
    return bytes;
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const response = await fetch(this.deliveryUrl(key));
      if (!response.ok) return null;
      return Buffer.from(await response.arrayBuffer());
    } catch {
      return null;
    }
  }

  async getStream(key: string): Promise<Readable | null> {
    const body = await this.get(key);
    return body ? Readable.from(body) : null;
  }

  async exists(key: string): Promise<boolean> {
    try {
      const response = await fetch(this.deliveryUrl(key), { method: 'HEAD' });
      return response.ok;
    } catch {
      return false;
    }
  }

  async delete(_key: string): Promise<void> {
    // Les logos sont immuables et hashés. La suppression d’assets Cloudinary
    // nécessite une API de destruction séparée, volontairement hors du chemin de lecture.
  }

  async signedUrl(key: string, _expiresInSeconds: number): Promise<string> {
    return this.deliveryUrl(key);
  }

  private async upload(key: string, body: Buffer, contentType?: string): Promise<void> {
    const resourceType = contentType?.startsWith('image/') ? 'image' : 'raw';
    const publicId = this.publicId(key);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sha1(`public_id=${publicId}&timestamp=${timestamp}${this.apiSecret}`);
    const form = new FormData();
    form.append('file', new Blob([body], { type: contentType ?? 'application/octet-stream' }));
    form.append('api_key', this.apiKey);
    form.append('timestamp', String(timestamp));
    form.append('public_id', publicId);
    form.append('signature', signature);
    const response = await fetch(`https://api.cloudinary.com/v1_1/${this.cloudName}/${resourceType}/upload`, { method: 'POST', body: form });
    if (!response.ok) throw new Error(`Cloudinary upload failed (${response.status})`);
  }

  private publicId(key: string): string {
    return `${this.folder}/${key.replace(/^\/+/, '').replace(/\.[^/.]+$/, '')}`;
  }

  private deliveryUrl(key: string): string {
    const resourceType = /\.(png|jpe?g|webp|gif|svg|ico)$/i.test(key) ? 'image' : 'raw';
    const extension = key.match(/\.[^/.]+$/)?.[0] ?? '';
    return `https://res.cloudinary.com/${this.cloudName}/${resourceType}/upload/${this.publicId(key)}${resourceType === 'image' ? extension : ''}`;
  }
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}
