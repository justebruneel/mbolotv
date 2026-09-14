// ============================================================================
// MeshStream v1 — primitives cryptographiques du protocole (ADR-0004).
// Implémentation UNIQUE partagée par l'API (émission des jetons, swarmIds) et
// le worker mesh (vérification) : la cohérence API<->mesh est garantie par la
// construction, pas par la recopie. WebCrypto uniquement (Worker + Node >= 19
// + navigateur) ; aucune dépendance runtime en plus de zod (déjà requis).
// ============================================================================
import { meshTokenPayloadSchema, type MeshTokenPayload } from './mesh';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function bytesFromB64url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function b64urlEncode(text: string): string { return b64urlFromBytes(encoder.encode(text)); }
function b64urlDecode(text: string): string { return decoder.decode(bytesFromB64url(text)); }

async function hmacBytes(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return new Uint8Array(mac);
}
async function hmacHex(secret: string, value: string): Promise<string> {
  return [...(await hmacBytes(secret, value))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** peerId : 16 octets aléatoires cryptographiques, base64url sans padding (22 car.). Jamais dérivé du deviceId. */
export function newMeshPeerId(): string {
  return b64urlFromBytes(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * swarmId = hex128(HMAC(secret, "mswarm|1|sourceId|channelId|variantId|ecoFlag")).
 * streamEpoch résolu (étape 3) : c'est variantId — l'id survit aux ré-imports
 * (importer.js met à jour le locator, jamais l'id) et change quand la source
 * change : déterministe, pas de fragmentation, aucune colonne ajoutée.
 * Ni `rid` (rendition ABR) ni `cc` n'entrent dans le swarm : la compatibilité
 * de rendition est vérifiée message par message (HELLO.rid / HEARTBEAT.rid).
 */
export async function computeMeshSwarmId(
  secret: string,
  parts: { sourceId: string; channelId: string; variantId: string; ecoFlag: 'eco' | 'hd' },
): Promise<string> {
  const canonical = ['mswarm', 1, parts.sourceId, parts.channelId, parts.variantId, parts.ecoFlag].join('|');
  return (await hmacHex(secret, canonical)).slice(0, 32);
}

/** did : clé de limitation par appareil, SANS deviceHash ni IP, rotation quotidienne. */
export async function deriveMeshDid(secret: string, deviceHash: string, dayKey: string): Promise<string> {
  return (await hmacHex(secret, `${deviceHash}|${dayKey}`)).slice(0, 32);
}

export type MeshTokenPayloadT = MeshTokenPayload;

/** token = b64url(JSON(payload)) + "." + b64url(HMAC(secret, b64url(JSON(payload)))) — même famille que x-sig du video-proxy. */
export async function createMeshToken(secret: string, payload: MeshTokenPayloadT): Promise<string> {
  const checked = meshTokenPayloadSchema.parse(payload);
  const body = b64urlEncode(JSON.stringify(checked));
  const sig = b64urlFromBytes(await hmacBytes(secret, body));
  return `${body}.${sig}`;
}

/** Vérification cryptographique et structurelle SEULE. Les règles temporelles (expiration, âge) sont métier, côté worker. */
export async function verifyMeshTokenSignature(
  secret: string,
  token: string,
): Promise<{ ok: true; payload: MeshTokenPayloadT } | { ok: false; reason: 'FORMAT' | 'SIGNATURE' | 'SCHEMA' }> {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return { ok: false, reason: 'FORMAT' };
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) return { ok: false, reason: 'FORMAT' };
  const [body, sig] = [token.slice(0, dot), token.slice(dot + 1)];
  const expected = b64urlFromBytes(await hmacBytes(secret, body));
  if (!timingSafeEqual(sig, expected)) return { ok: false, reason: 'SIGNATURE' };
  let json: unknown;
  try { json = JSON.parse(b64urlDecode(body)); } catch { return { ok: false, reason: 'FORMAT' }; }
  const parsed = meshTokenPayloadSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: 'SCHEMA' };
  return { ok: true, payload: parsed.data as MeshTokenPayloadT };
}

/**
 * Lecture des claims côté CLIENT (sans vérification : le client ne détient
 * pas le secret). Les claims sont des IDENTIFIANTS émis serveur (pid/sid) —
 * le client ne les UTILISE pas comme preuve, il les renvoie tels quels au
 * coordinateur qui, lui, vérifie la signature. Payload illisible → null
 * (le client n'active alors simplement pas le mesh).
 */
export function readMeshTokenClaims(token: string): MeshTokenPayloadT | null {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  try {
    const parsed = meshTokenPayloadSchema.safeParse(JSON.parse(b64urlDecode(token.slice(0, dot))));
    return parsed.success ? (parsed.data as MeshTokenPayloadT) : null;
  } catch { return null; }
}
