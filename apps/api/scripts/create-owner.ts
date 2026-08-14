import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Algorithm, hash } from '@node-rs/argon2';
import { PrismaClient } from '@prisma/client';
import { PasswordService } from '../src/common/password/password.service';

function loadEnv(): void {
  for (const envPath of [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../.env'),
    resolve(process.cwd(), '../../.env'),
  ]) {
    if (!existsSync(envPath)) continue;
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

async function hiddenQuestion(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolvePrompt) => {
    output.write(prompt);
    const onData = (char: Buffer): void => {
      const str = char.toString();
      if (str === '\r' || str === '\n') {
        output.write('\n');
        process.stdin.off('data', onData);
        process.stdin.pause();
        resolvePrompt(process.stdin.read()?.toString().trim() ?? '');
      } else if (str === '\u0003') {
        process.exit(130);
      } else {
        output.write('*');
      }
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  loadEnv();
  const passwordService = new PasswordService();

  const prisma = new PrismaClient();
  const rl = readline.createInterface({ input, output });

  try {
    const defaultEmail = process.env['OWNER_EMAIL'] ?? 'owner@example.com';
    const email = (await rl.question(`E-mail du propriétaire [${defaultEmail}] : `)).trim() || defaultEmail;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      console.error('E-mail invalide.');
      return;
    }

    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) {
      console.error(`Un compte existe déjà pour ${email} (rôle ${existing.role}). Provisionnement refusé.`);
      return;
    }

    const password =
      process.env['OWNER_PASSWORD'] ?? (await hiddenQuestion(rl, `Mot de passe (16 caractères min) : `));
    try {
      passwordService.assertStrongPassword(password);
    } catch (error) {
      console.error((error as Error).message);
      return;
    }

    const passwordHash = await hash(password, { algorithm: Algorithm.Argon2id });

    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        role: 'OWNER',
        passwordHash,
      },
    });

    console.log('\n=== Compte propriétaire créé ===');
    console.log(`ID     : ${user.id}`);
    console.log(`E-mail : ${email.toLowerCase()}`);
    console.log(`Rôle   : OWNER`);
  } finally {
    rl.close();
    await prisma.$disconnect();
  }
}

void main();