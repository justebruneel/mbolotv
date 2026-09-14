// Vérification des meshTokens côté worker mesh. L'implémentation du HMAC, de
// l'encodage et du schéma vit dans @mbolo/contracts (mesh-token.ts) : API
// (émission) et mesh (vérification) partagent la MÊME fonction — la cohérence
// est structurelle, pas documentaire. Ce fichier n'ajoute que les règles
// métier temporelles que le schéma Zod ne peut pas exprimer.
import { verifyMeshTokenSignature } from "@mbolo/contracts";

// Tolérance d'horloge : un jeton émis « dans le futur » de plus de 60 s est
// soit une horloge client cassée, soit une anomalie — rejeté dans les deux cas.
const CLOCK_SKEW_MS = 60_000;

/**
 * @returns {ok:true,payload} | {ok:false, reason:'INVALID'|'EXPIRED'}
 * reason est volontairement grossier : le client n'a pas à savoir POURQUOI le
 * jeton est mort (énumération de swarms impossibilité).
 */
export async function verifyMeshToken(secret, token, nowMs = Date.now()) {
  const verified = await verifyMeshTokenSignature(secret, token);
  if (!verified.ok) return { ok: false, reason: "INVALID" };
  const { payload } = verified;
  if (payload.exp <= payload.iat) return { ok: false, reason: "INVALID" };
  if (payload.iat > nowMs + CLOCK_SKEW_MS) return { ok: false, reason: "INVALID" };
  if (nowMs >= payload.exp) return { ok: false, reason: "EXPIRED" };
  return { ok: true, payload };
}
