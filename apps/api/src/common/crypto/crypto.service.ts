import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CryptoService implements OnModuleInit {
  private key!: Buffer;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const secret = this.config.getOrThrow<string>('ENCRYPTION_KEY');
    if (secret.length < 16) {
      throw new Error('ENCRYPTION_KEY doit contenir au moins 16 caractères');
    }
    // La clé est toujours dérivée par SHA-256 : stable que la valeur soit
    // un base64 valide (prod) ou un placeholder (dev).
    this.key = createHash('sha256').update(secret).digest();
  }

  encrypt(plaintext: string): Uint8Array<ArrayBuffer> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return new Uint8Array(Buffer.concat([iv, tag, encrypted]));
  }

  decrypt(payload: Uint8Array): string {
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const data = payload.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('hex');
  }
}