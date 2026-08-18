import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StorageService } from './storage.interface';

@Injectable()
export class S3StorageService implements StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  constructor(config: ConfigService) { this.bucket = config.getOrThrow<string>('S3_BUCKET'); this.client = new S3Client({ region: config.get<string>('S3_REGION', 'auto'), endpoint: config.get<string>('S3_ENDPOINT') || undefined, credentials: { accessKeyId: config.getOrThrow<string>('S3_ACCESS_KEY'), secretAccessKey: config.getOrThrow<string>('S3_SECRET_KEY') } }); }
  async put(key: string, body: Buffer, contentType?: string): Promise<void> { await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType })); }
  async putStream(key: string, stream: Readable, contentType: string | undefined, maxBytes: number): Promise<number> {
    const body = new PassThrough(); let bytes = 0;
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; callback(bytes > maxBytes ? new Error('Contenu trop volumineux') : null, chunk); } });
    const upload = this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
    try { await pipeline(stream, limiter, body); await upload; return bytes; } catch (error) { body.destroy(); throw error; }
  }
  async get(key: string): Promise<Buffer | null> { try { const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })); const bytes = await result.Body?.transformToByteArray(); return bytes ? Buffer.from(bytes) : null; } catch (error) { if (error instanceof Error && error.name === 'NoSuchKey') return null; throw error; } }
  async getStream(key: string): Promise<Readable | null> { try { const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })); return result.Body as Readable; } catch (error) { if (error instanceof Error && error.name === 'NoSuchKey') return null; throw error; } }
  async exists(key: string): Promise<boolean> { try { await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); return true; } catch { return false; } }
  async delete(key: string): Promise<void> { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
  async signedUrl(key: string, expiresInSeconds: number): Promise<string> { return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresInSeconds }); }
}
