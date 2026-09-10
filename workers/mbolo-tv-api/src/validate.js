// Validation des entrées par les schémas Zod partagés de @mbolo/contracts
// (ADR-0002 Phase 2). Le Worker et l'API de référence (apps/api, via son
// ZodValidationPipe) doivent rejeter et accepter exactement les mêmes corps,
// avec le même format de réponse — d'où un seul point d'entrée ici, utilisé
// par owner-routes.js comme par owner-vod.js.
//
// Réponse d'erreur identique au ZodValidationPipe :
//   { message: 'Validation failed', issues: [{ path, message }], statusCode: 400 }
// Les messages portés par les .refine() des contrats ('Aucune modification')
// ressortent donc dans issues, comme côté NestJS.

/**
 * @param {{ fail: (status: number, message: string) => Response, json: (value: unknown, status?: number) => Response }} ctx
 * @param {import('zod').ZodTypeAny} schema schéma de @mbolo/contracts
 * @param {unknown} body corps JSON parsé (peut être null/indéfini)
 * @returns {{ value: any } | { response: Response }}
 */
export function parseContract(ctx, schema, body) {
  const result = schema.safeParse(body);
  if (result.success) return { value: result.data };
  const issues = result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
  return { response: ctx.json({ message: "Validation failed", issues, statusCode: 400 }, 400) };
}
