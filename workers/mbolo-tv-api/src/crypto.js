const encoder = new TextEncoder();

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function derivedKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Format identique à CryptoService (Nest) : iv(12) + tag(16) + ciphertext,
// clé dérivée SHA-256(ENCRYPTION_KEY). WebCrypto attend le tag en suffixe
// du ciphertext, ce qui correspond exactement.
export async function decryptLocator(key, payload) {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const iv = bytes.slice(0, 12);
  const data = bytes.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(plaintext);
}

export async function encryptLocator(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext)));
  const payload = new Uint8Array(iv.length + sealed.length);
  payload.set(iv);
  payload.set(sealed, iv.length);
  return payload;
}

export async function importKey(secret) {
  return derivedKey(secret);
}

export async function decryptLocatorWithSecret(secret, payload) {
  return decryptLocator(await derivedKey(secret), payload);
}
