import { BadRequestException } from '@nestjs/common';
import { assertSafeUrl, isPrivateIp } from './safe-fetcher';

describe('safe-fetcher', () => {
  it('détecte les plages d’IP privées IPv4', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
  });

  it('détecte les IP privées IPv6', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('::')).toBe(true);
    expect(isPrivateIp('fd00::1')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('2001:4860:4860::8888')).toBe(false);
  });

  it('rejette une URL vers une IP privée littérale (SSRF)', async () => {
    await expect(assertSafeUrl('http://127.0.0.1/secret')).rejects.toThrow(BadRequestException);
    await expect(assertSafeUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejette les protocoles non http(s)', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow(BadRequestException);
    await expect(assertSafeUrl('ftp://example.com/x')).rejects.toThrow(BadRequestException);
  });
});
