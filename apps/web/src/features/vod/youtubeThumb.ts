// Proxy de miniatures YouTube via notre domaine : les FAI qui filtrent les
// SNI youtube.com/i.ytimg.com (handshake TLS tué) bloquent l'accès direct du
// navigateur à i.ytimg.com. Le serveur Vercel (egress non filtré) stream
// l'image ; Cache-Control long -> chaque miniature n'est récupérée d'YouTube
// qu'une fois par edge (coût bande passante négligeable).
// Chemin REST : /api/yt/img?id=<videoId>&q=<maxres|sd|hq|mq> (défaut hq).
const YTIMG = 'https://i.ytimg.com/vi';
const QUALITIES = ['maxres', 'sd', 'hq', 'mq'] as const;

export type ThumbQuality = (typeof QUALITIES)[number];

export function parseThumbQuality(value: string | null): ThumbQuality {
  return (QUALITIES as readonly string[]).includes(value ?? '') ? (value as ThumbQuality) : 'hq';
}

const FILE_BY_QUALITY: Record<ThumbQuality, string> = {
  maxres: 'maxresdefault.jpg',
  sd: 'sddefault.jpg',
  hq: 'hqdefault.jpg',
  mq: 'mqdefault.jpg',
};

export function thumbUpstreamUrl(videoId: string, quality: ThumbQuality): string {
  return `${YTIMG}/${videoId}/${FILE_BY_QUALITY[quality]}`;
}

// Réécrit une URL i.ytimg.com renvoyée par l'API Data v3 vers le proxy local.
// Les URL inconnues (hors miniature YouTube) passent inchangées : elles ne
// subissent pas le blocage SNI et notre regex d'ID ne s'appliquerait pas.
export function proxiedThumbUrl(posterUrl: string | null | undefined): string | null {
  if (!posterUrl) return null;
  const match = /i\.ytimg\.com\/vi\/([A-Za-z0-9_-]{11})\/([a-z]+default)\.jpg/i.exec(posterUrl);
  if (!match) return posterUrl;
  const [, videoId, file] = match;
  const quality = file.startsWith('maxres') ? 'maxres' : file.startsWith('sd') ? 'sd' : file.startsWith('mq') ? 'mq' : 'hq';
  return `/api/yt/img?id=${videoId}&q=${quality}`;
}
