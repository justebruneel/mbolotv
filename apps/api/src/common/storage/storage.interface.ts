export abstract class StorageService {
  abstract put(key: string, body: Buffer, contentType?: string): Promise<void>;
  abstract get(key: string): Promise<Buffer | null>;
  abstract delete(key: string): Promise<void>;
  abstract signedUrl(key: string, expiresInSeconds: number): Promise<string>;
}
