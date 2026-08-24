const encoder = new TextEncoder();
// Plafond du runtime Workers : deriveBits(PBKDF2) refuse > 100 000 itérations.
// Compte OWNER unique + rate limiting login → compromis acceptable.
const PBKDF2_ITERATIONS = 100_000;
// Format PHC versionné propre au projet : $pbkdf2-sha256$v=1$<iter>$<salt b64url>$<hash b64url>
// (Argon2id étant indisponible en WebCrypto, le compte OWNER unique est migré vers PBKDF2).
const ALG_PREFIX = "$pbkdf2-sha256$v=1$";

function b64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function derive(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    keyMaterial,
    256,
  );
}

export function assertStrongPassword(password) {
  const trivial = new Set([
    "password",
    "123456789",
    "qwertyuiop",
    "motdepasse",
    "azerty123456",
    "motdepasse123",
    "azertyuiop",
    "00000000000000",
  ]);
  return password.length >= 16 && !trivial.has(password.toLowerCase());
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, PBKDF2_ITERATIONS);
  return `${ALG_PREFIX}${PBKDF2_ITERATIONS}$${b64UrlEncode(salt)}$${b64UrlEncode(new Uint8Array(bits))}`;
}

// Vérifie les deux formats : le nouveau PBKDF2 et l'ancien Argon2id PHC
// ($argon2id$...) dont la vérification native est impossible côté Worker —
// ces comptes doivent être re-provisionnés via scripts/bootstrap-owner.mjs.
export async function verifyPassword(passwordHash, password) {
  if (!passwordHash?.startsWith(ALG_PREFIX)) {
    console.error("[auth] hash non-PBKDF2 rencontré : re-provisionner via bootstrap-owner.mjs");
    return false;
  }
  try {
    const [, , , iterationsRaw, saltRaw, hashRaw] = passwordHash.split("$");
    const iterations = Number(iterationsRaw);
    if (!Number.isFinite(iterations) || iterations < 90_000) return false;
    const expected = b64UrlDecode(hashRaw);
    const actual = new Uint8Array(await derive(password, b64UrlDecode(saltRaw), iterations));
    if (expected.length !== actual.length) return false;
    let diff = 0;
    for (let index = 0; index < expected.length; index += 1) diff |= expected[index] ^ actual[index];
    return diff === 0;
  } catch (error) {
    console.error("[auth] pbkdf2 verify:", error instanceof Error ? error.message : error);
    return false;
  }
}
