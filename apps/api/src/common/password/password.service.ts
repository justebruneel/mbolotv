import { Algorithm, hash, verify } from '@node-rs/argon2';
import { Injectable } from '@nestjs/common';

const COMMON_PASSWORDS = new Set([
  'password',
  'motdepasse',
  '1234567890123456',
  'qwertyuiopasdfgh',
  'abcdefghijklmnop',
  'passwordpassword',
  'changemepassword',
  'iloveyou12345678',
]);

@Injectable()
export class PasswordService {
  async hashPassword(password: string): Promise<string> {
    return hash(password, { algorithm: Algorithm.Argon2id });
  }

  async verifyPassword(passwordHash: string, password: string): Promise<boolean> {
    return verify(passwordHash, password);
  }

  assertStrongPassword(password: string): void {
    if (password.length < 16) {
      throw new Error('Le mot de passe doit contenir au moins 16 caractères');
    }
    if (COMMON_PASSWORDS.has(password.toLowerCase())) {
      throw new Error('Ce mot de passe est trop courant, choisissez-en un autre');
    }
  }
}