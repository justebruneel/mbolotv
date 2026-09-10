// Tests de la Phase 2 (ADR-0002) : le Worker valide désormais ses entrées
// owner avec les schémas Zod de @mbolo/contracts — la MÊME source de vérité
// que l'API de référence (apps/api) et le frontend (apps/web).
// Lancer : node --test 'workers/mbolo-tv-api/test/*.test.mjs'
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ownerLoginSchema,
  ownerProfileUpdateSchema,
  accessCodeCreateSchema,
  announcementCreateSchema,
  sourceCreateSchema,
  sourceImportSchema,
} from "@mbolo/contracts";

describe("contrats partagés — le Worker et NestJS valident la même source", () => {
  it("login : e-mail invalide / mot de passe vide rejetés", () => {
    assert.equal(ownerLoginSchema.safeParse({ email: "pas-un-email", password: "x" }).success, false);
    assert.equal(ownerLoginSchema.safeParse({ email: "a@b.co", password: "" }).success, false);
    assert.equal(ownerLoginSchema.safeParse({ email: "a@b.co", password: "x".repeat(201) }).success, false);
    assert.equal(ownerLoginSchema.safeParse({ email: "owner@mbolo.tv", password: "motdepasse" }).success, true);
  });

  it("profil : corps vide refusé ('Aucune modification', comme le .refine() NestJS)", () => {
    const empty = ownerProfileUpdateSchema.safeParse({});
    assert.equal(empty.success, false);
    assert.ok(empty.error.issues.some((issue) => issue.message === "Aucune modification"));
    assert.equal(ownerProfileUpdateSchema.safeParse({ whatsappContact: "+241000000" }).success, true);
    assert.equal(ownerProfileUpdateSchema.safeParse({ whatsappContact: null }).success, true);
  });

  it("access-code : defaults Zod appliqués (kind STANDARD) — comportement Worker inchangé", () => {
    const parsed = accessCodeCreateSchema.parse({});
    assert.equal(parsed.kind, "STANDARD");
    assert.equal(accessCodeCreateSchema.safeParse({ kind: "BIDON" }).success, false);
    assert.equal(accessCodeCreateSchema.safeParse({ kind: "PROMO" }).success, true);
    assert.equal(accessCodeCreateSchema.safeParse({ durationDays: 8 }).success, false,
      "le Worker tolérait durationDays inconnu (repli 7) : la référence rejette, le contrat fait foi");
  });

  it("annonce : bornes 3-80 / 3-500 et kind par défaut INFO", () => {
    const parsed = announcementCreateSchema.parse({ title: "abc", body: "def" });
    assert.equal(parsed.kind, "INFO");
    assert.equal(announcementCreateSchema.safeParse({ title: "ab", body: "def" }).success, false);
    assert.equal(announcementCreateSchema.safeParse({ title: "abc", body: "def" }).success, true);
  });

  it("source : kind strict et connection objet obligatoire", () => {
    assert.equal(sourceCreateSchema.safeParse({ name: "ma source", kind: "M3U", connection: { url: "https://x" } }).success, true);
    assert.equal(sourceCreateSchema.safeParse({ name: "ma source", kind: "RTMP", connection: {} }).success, false);
    assert.equal(sourceCreateSchema.safeParse({ name: "a", kind: "M3U", connection: {} }).success, false,
      "name min(2) : un seul caractère est rejeté par la référence");
  });

  it("import : scope inconnu rejeté (avant, le worker normalisait silencieusement)", () => {
    assert.equal(sourceImportSchema.safeParse({ scope: "live" }).success, true);
    assert.equal(sourceImportSchema.safeParse({ scope: "bidon" }).success, false);
  });

  // Format d'erreur : le Worker renvoie { message: 'Validation failed', issues }
  // exactement comme le ZodValidationPipe de l'API de référence.
  it("format des issues : path + message (parité ZodValidationPipe)", () => {
    const bad = ownerLoginSchema.safeParse({ email: "x", password: "" });
    assert.equal(bad.success, false);
    const issues = bad.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    assert.ok(issues.some((issue) => issue.path === "email"));
    assert.ok(issues.some((issue) => issue.path === "password"));
  });
});
