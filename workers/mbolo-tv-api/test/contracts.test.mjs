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
  ownerVodFolderCreateSchema,
  ownerVodFolderUpdateSchema,
  ownerVodRulesPutSchema,
  ownerVodItemsAddSchema,
  ownerVodItemAssignSchema,
  ownerVodYoutubeCreateSchema,
  ownerExternalTitleUpdateSchema,
  ownerExternalSourceUpdateSchema,
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

  // ---- owner-vod.js (lot 2 de la Phase 2) ----
  it("dossier VOD : kind strict, corps vide refusé au PATCH", () => {
    assert.equal(ownerVodFolderCreateSchema.safeParse({ name: "Films", kind: "MOVIE" }).success, true);
    assert.equal(ownerVodFolderCreateSchema.safeParse({ name: "Films", kind: "DOCUMENTAIRE" }).success, false,
      "le worker tolérait un kind inconnu (repli BOTH) : la référence rejette");
    const empty = ownerVodFolderUpdateSchema.safeParse({});
    assert.equal(empty.success, false);
    assert.ok(empty.error.issues.some((issue) => issue.message === "Aucune modification"));
  });

  it("règles : array categoryTitles requis (PUT = remplacement intégral)", () => {
    assert.equal(ownerVodRulesPutSchema.safeParse({ categoryTitles: ["Action", "Comédie"] }).success, true);
    assert.equal(ownerVodRulesPutSchema.safeParse({}).success, false,
      "avant le contrat, un corps sans categoryTitles passait et vidait les règles");
    assert.equal(ownerVodRulesPutSchema.safeParse({ categoryTitles: [] }).success, true);
    assert.equal(ownerVodRulesPutSchema.safeParse({ categoryTitles: [""] }).success, false);
  });

  it("items : itemIds min(1) max(200) — le 'Aucun titre sélectionné' devient 400 contrat", () => {
    assert.equal(ownerVodItemsAddSchema.safeParse({ itemIds: ["a"] }).success, true);
    assert.equal(ownerVodItemsAddSchema.safeParse({ itemIds: [] }).success, false);
    assert.equal(ownerVodItemsAddSchema.safeParse({ itemIds: Array(201).fill("x") }).success, false);
  });

  it("assignation d'item : folderIds requis même vide (liste faisant foi)", () => {
    assert.equal(ownerVodItemAssignSchema.safeParse({ folderIds: [] }).success, true);
    assert.equal(ownerVodItemAssignSchema.safeParse({}).success, false);
    assert.equal(ownerVodItemAssignSchema.safeParse({ folderIds: ["a"], isVisible: false }).success, true);
  });

  it("YouTube : channelId strict UC+22 (la regex du worker vit dans le contrat)", () => {
    assert.equal(ownerVodYoutubeCreateSchema.safeParse({ channelId: "UC" + "a".repeat(22) }).success, true);
    assert.equal(ownerVodYoutubeCreateSchema.safeParse({ channelId: "channelhandle" }).success, false);
  });

  it("titre externe : year 1900-2100, posterUrl URL, refine 'Aucune modification'", () => {
    assert.equal(ownerExternalTitleUpdateSchema.safeParse({ title: "Ok" }).success, true);
    assert.equal(ownerExternalTitleUpdateSchema.safeParse({ year: 1899 }).success, false);
    assert.equal(ownerExternalTitleUpdateSchema.safeParse({ posterUrl: "pas une url" }).success, false);
    const empty = ownerExternalSourceUpdateSchema.safeParse({});
    assert.equal(empty.success, false);
    assert.ok(empty.error.issues.some((issue) => issue.message === "Aucune modification"));
  });
});
