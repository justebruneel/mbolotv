import type { BadgeTone } from '@mbolo/ui';
import { Badge } from '@mbolo/ui';

export type SourceStatus = 'PENDING' | 'IMPORTING' | 'READY' | 'DEGRADED' | 'FAILED' | 'DISABLED';
export type ImportState = 'QUEUED' | 'FETCHING' | 'PARSING' | 'NORMALIZING' | 'COMPLETED' | 'FAILED' | 'CANCELED';

const SOURCE_META: Record<SourceStatus, { label: string; tone: BadgeTone; live?: boolean }> = {
  READY: { label: 'Prête', tone: 'success' }, PENDING: { label: 'En attente', tone: 'default' }, IMPORTING: { label: 'Import…', tone: 'accent', live: true }, DEGRADED: { label: 'Dégradée', tone: 'warning' }, FAILED: { label: 'En erreur', tone: 'danger' }, DISABLED: { label: 'Désactivée', tone: 'default' },
};
const IMPORT_META: Record<ImportState, { label: string; tone: BadgeTone; live?: boolean }> = {
  QUEUED: { label: 'En file', tone: 'default' }, FETCHING: { label: 'Téléchargement', tone: 'accent', live: true }, PARSING: { label: 'Analyse', tone: 'accent', live: true }, NORMALIZING: { label: 'Normalisation', tone: 'accent', live: true }, COMPLETED: { label: 'Terminé', tone: 'success' }, FAILED: { label: 'Échec', tone: 'danger' }, CANCELED: { label: 'Annulé', tone: 'default' },
};
export const SOURCE_KIND_LABEL: Record<string, string> = { M3U: 'M3U', XTREAM: 'Xtream Codes', MAC_PORTAL: 'MAG / Stalker' };
// Périmètre d'un import : 'live' = chaînes, 'vod' = films & séries sans les
// chaînes, 'all' = complet. Repli 'Complet' pour les runs antérieurs.
export const IMPORT_SCOPE_LABEL: Record<string, string> = { live: 'Chaînes', vod: 'Films & séries', movies: 'Films seuls', series: 'Séries seules', all: 'Complet' };
export function SourceStatusBadge({ status }: { status: string }) { const meta = SOURCE_META[status as SourceStatus] ?? { label: status, tone: 'default' as BadgeTone }; return <Badge tone={meta.tone} live={meta.live}>{meta.label}</Badge>; }
export function ImportStateBadge({ state }: { state: string }) { const meta = IMPORT_META[state as ImportState] ?? { label: state, tone: 'default' as BadgeTone }; return <Badge tone={meta.tone} live={meta.live}>{meta.label}</Badge>; }
export function KindBadge({ kind }: { kind: string }) { return <Badge tone="accent">{SOURCE_KIND_LABEL[kind] ?? kind}</Badge>; }
