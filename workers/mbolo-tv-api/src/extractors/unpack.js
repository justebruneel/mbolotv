// Désobfuscation partagée : les players tiers packent leur JS
// (Dean Edwards P,A,C,K / eval) pour cacher l'URL CDN.
// Stratégie : regex directes d'abord (souvent suffisantes, ex. wurl en
// clair), unpack générique ensuite. Un seul unpacker à maintenir.

/** Extrait MDCore.wurl (Mixdrop) d'un HTML, packé ou non. Retourne null si absent. */
export function extractWurl(html) {
  const source = String(html ?? '');
  // 1) En clair : MDCore.wurl="…", MDCore.wurl='…', wurl:"…".
  const direct = /(?:MDCore\.wurl|["']wurl["'])\s*[:=]\s*["']([^"']+)["']/.exec(source);
  if (direct?.[1]) return direct[1];
  // 2) Dans du packé : unpack puis re-cherche.
  for (const packed of findPackedBlocks(source)) {
    try {
      const unpacked = unpackPacker(packed);
      const found = /(?:MDCore\.wurl|["']wurl["'])\s*[:=]\s*["']([^"']+)["']/.exec(unpacked);
      if (found?.[1]) return found[1];
    } catch {
      continue;
    }
  }
  return null;
}

// Pattern unique du P,A,C,K (partagé par find + unpack) : noms de params
// génériques ([^)]* — les hosts renomment p,a,c,k,e,d), payload/radix/count/
// dict en groupes 1-4. Limite connue : payload/dict avec apostrophe échappée
// (\') coupent le match — les players Mixdrop/Dood ne le font pas en pratique.
const PACKER_PATTERN = /eval\(function\([^)]*\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/g;

/** Repère les blocs eval(…) du packer Dean Edwards. */
export function findPackedBlocks(html) {
  const blocks = [];
  // Boucle bornée : une page embed en contient rarement plus de 3.
  for (let i = 0; i < 10; i += 1) {
    const match = PACKER_PATTERN.exec(String(html ?? ''));
    if (!match) break;
    blocks.push(match[0]);
  }
  // exec avec flag g garde un lastIndex mutable : réinitialiser pour les
  // appels suivants (sinon un 2e appel repartirait en milieu de chaîne).
  PACKER_PATTERN.lastIndex = 0;
  return blocks;
}

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Unpack du P,A,C,K de Dean Edwards : remplace les tokens base62 (c[k])
 * par les mots du dictionnaire k. Implémentation minimale (radix ≤ 62),
 * suffisante pour les players tiers — pas un évaluateur JS générique.
 */
export function unpackPacker(packed) {
  PACKER_PATTERN.lastIndex = 0;
  const outer = PACKER_PATTERN.exec(String(packed));
  PACKER_PATTERN.lastIndex = 0;
  if (!outer) throw new Error('Bloc packé non reconnu');
  const [, payload, radixRaw, countRaw, dictRaw] = outer;
  const radix = Number(radixRaw);
  const count = Number(countRaw);
  if (!Number.isFinite(radix) || radix < 2 || radix > 62 || !Number.isFinite(count)) {
    throw new Error('Paramètres packer invalides');
  }
  const dict = dictRaw.split('|');
  const encode = (num) => {
    if (num === 0) return '0';
    let out = '';
    let value = num;
    while (value > 0) {
      out = BASE62[value % radix] + out;
      value = Math.floor(value / radix);
    }
    return out;
  };
  const table = new Map();
  for (let i = 0; i < count; i += 1) table.set(encode(i), dict[i] ?? '');
  // Parité avec le décodeur de référence : TOUT token présent au dictionnaire
  // est remplacé, y compris par '' quand l'entrée est vide (ex. 'a||b').
  // Ne garder le token que s'il est absent de la table.
  return String(payload).replace(/\b\w+\b/g, (token) => (table.has(token) ? table.get(token) : token));
}

/** Titre de la page embed (<title> ou MDCore.title), null si absent. */
export function extractTitle(html) {
  const source = String(html ?? '');
  const titled = /MDCore\.title\s*=\s*["']([^"']+)["']/.exec(source);
  if (titled?.[1]) return titled[1].trim();
  const tag = /<title[^>]*>([^<]+)<\/title>/i.exec(source);
  if (tag?.[1]) return tag[1].replace(/\s*[-|–]\s*Mix[Dd]rop.*$/, '').trim() || null;
  return null;
}

/** Normalise une URL CDN protocole-relative (//host/…) vers https. */
export function absolutizeCdnUrl(raw) {
  const value = String(raw ?? '').trim();
  if (value.startsWith('//')) return `https:${value}`;
  return value;
}

export const _internal = { BASE62 };
