// Fonctions pures d'arbre partagées entre « Catalogue public » (catégories de
// chaînes live) et « Catalogue VOD » (dossiers vidéo) : aplatissement,
// cartographie des fratries (pour ↑/↓) et indexation par parent (pour le
// sélecteur de déplacement, qui doit exclure le sous-arbre du nœud déplacé).

export interface OrderInfo<T> {
  siblings: T[];
  index: number;
}

type TreeNode<T> = { id: string; parentId: string | null; children?: T[] };

export function flattenTree<T extends TreeNode<T>>(nodes: T[], acc: T[] = []): T[] {
  for (const node of nodes) { acc.push(node); flattenTree(node.children ?? [], acc); }
  return acc;
}

export function buildOrderMap<T extends TreeNode<T>>(nodes: T[]): Map<string, OrderInfo<T>> {
  const map = new Map<string, OrderInfo<T>>();
  const walk = (list: T[]): void => {
    list.forEach((node, index) => { map.set(node.id, { siblings: list, index }); walk(node.children ?? []); });
  };
  walk(nodes);
  return map;
}

export function buildChildrenByParent<T extends TreeNode<T>>(nodes: T[]): Map<string | null, T[]> {
  const map = new Map<string | null, T[]>();
  const walk = (list: T[]): void => {
    for (const node of list) {
      const bucket = map.get(node.parentId) ?? [];
      bucket.push(node);
      map.set(node.parentId, bucket);
      walk(node.children ?? []);
    }
  };
  walk(nodes);
  return map;
}
