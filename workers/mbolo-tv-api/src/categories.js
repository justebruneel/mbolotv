// Réplique fidèle de hiddenCategoryIds() (channels.service.ts) : visibilité
// effective d'un arbre de catégories, avec protection contre les cycles.
export function hiddenCategoryIds(rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const effective = new Map();
  const visiting = new Set();
  const compute = (id) => {
    const cached = effective.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) {
      effective.set(id, false);
      return false;
    }
    visiting.add(id);
    const node = byId.get(id);
    if (!node) {
      visiting.delete(id);
      return false;
    }
    const parentOk =
      node.parentId == null || !byId.has(node.parentId)
        ? true
        : compute(node.parentId);
    const result = node.isVisible && parentOk;
    visiting.delete(id);
    effective.set(id, result);
    return result;
  };
  rows.forEach((row) => compute(row.id));
  return new Set(
    rows.filter((row) => !effective.get(row.id)).map((row) => row.id),
  );
}

export async function loadHiddenIds(env) {
  const result = await env.db.query(
    env,
    'SELECT id, "parentId", "isVisible" FROM "Category"',
  );
  return hiddenCategoryIds(result.rows);
}

export function categoryFilterSql(hiddenIds, slug, alias = "c", startIndex = 1) {
  // startIndex : position du premier paramètre DANS la requête finale de
  // l'appelant (les indices sont globaux, pas relatifs à ce module).
  const params = [];
  let sql = "";
  const clauses = [];
  if (hiddenIds.size > 0) {
    params.push([...hiddenIds]);
    clauses.push(
      `(${alias}."categoryId" IS NULL OR ${alias}."categoryId" <> ALL($${startIndex}::text[]))`,
    );
  }
  if (slug) {
    params.push(slug);
    clauses.push(
      `${alias}."categoryId" IN (SELECT id FROM "Category" WHERE slug = $${startIndex + 1})`,
    );
  }
  if (clauses.length > 0) sql = ` AND (${clauses.join(" AND ")})`;
  return { sql, params };
}
