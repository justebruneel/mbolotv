import { Readable } from 'node:stream';

export abstract class StorageService {
  abstract put(key: string, body: Buffer, contentType?: string): Promise<void>;
  abstract putStream(key: string, stream: Readable, contentType: string | undefined, maxBytes: number): Promise<number>;
  abstract get(key: string): Promise<Buffer | null>;
  abstract getStream(key: string): Promise<Readable | null>;
  abstract exists(key: string): Promise<boolean>;
  abstract delete(key: string): Promise<void>;
  abstract signedUrl(key: string, expiresInSeconds: number): Promise<string>;
}
