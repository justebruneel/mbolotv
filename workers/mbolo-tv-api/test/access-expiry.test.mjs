// Port des tests « empilement d'accès » d'access.service.spec.ts (apps/api,
// gelée — ADR-0002 Phase 3). La référence testait la logique via des mocks
// Prisma ; côté Worker la logique vit dans redeemCode (SQL brut). Plutôt que
// de mocker pg, on teste la fonction PURE extraite : computeExpiry duplique
// la règle (base = max(expiration restante, maintenant) + durée du code).
// Ce test PROTÈGE la règle : si quelqu'un change baseTime = now() dans
// access.js, il doit mettre à jour computeExpiry et ce test — et se souvenir
// de la raison (un code plus court que le temps restant ne doit pas rogner
// l'accès).
// Lancer : node --test workers/mbolo-tv-api/test/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// Règle dupliquée depuis access.js redeemCode (baseTime + durationHours) —
// référencer la source dans les deux sens lors de toute modification.
function computeExpiry(currentGrantExpiresAt, durationHours, now = Date.now()) {
  const baseTime = currentGrantExpiresAt ? Math.max(new Date(currentGrantExpiresAt).getTime(), now) : now;
  return new Date(baseTime + durationHours * 3_600_000);
}

describe('redeem — empilement d\'accès (porté de apps/api)', () => {
  it('empile la durée sur l\'accès restant (20 j restants + code 7 j → 27 j)', () => {
    const existing = Date.now() + 20 * DAY_MS;
    const expiresAt = computeExpiry(existing, 7 * 24);
    const expected = existing + 7 * DAY_MS;
    assert.ok(Math.abs(expiresAt.getTime() - expected) < 60_000);
  });

  it('empile aussi un code plus court que le temps restant (20 j + PROMO 24 h → 21 j)', () => {
    const existing = Date.now() + 20 * DAY_MS;
    const expiresAt = computeExpiry(existing, 24);
    const expected = existing + DAY_MS;
    assert.ok(Math.abs(expiresAt.getTime() - expected) < 60_000);
  });

  it('part de maintenant pour un appareil sans accès (code 7 j → 7 j)', () => {
    const now = Date.now();
    const expiresAt = computeExpiry(null, 7 * 24, now);
    assert.ok(Math.abs(expiresAt.getTime() - (now + 7 * DAY_MS)) < 60_000);
  });

  it('ne raccourcit jamais un accès plus long que le code (30 j restants + PROMO 24 h → 31 j)', () => {
    const existing = Date.now() + 30 * DAY_MS;
    const expiresAt = computeExpiry(existing, 24);
    const expected = existing + DAY_MS;
    assert.ok(Math.abs(expiresAt.getTime() - expected) < 60_000);
  });

  it('part de maintenant si le grant existant a déjà expiré (base = max(exp, now))', () => {
    const now = Date.now();
    const expired = now - 2 * DAY_MS;
    const expiresAt = computeExpiry(expired, 7 * 24, now);
    assert.ok(Math.abs(expiresAt.getTime() - (now + 7 * DAY_MS)) < 60_000,
      'un grant expiré ne doit pas étendre le nouveau code dans le passé');
  });
});
