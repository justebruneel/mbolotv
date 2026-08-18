const URI_ATTRIBUTE_TAGS = new Set([
  'EXT-X-KEY',
  'EXT-X-MAP',
  'EXT-X-PART',
  'EXT-X-PRELOAD-HINT',
  'EXT-X-RENDITION-REPORT',
  'EXT-X-SESSION-DATA',
  'EXT-X-IMAGE-STREAM-INF',
]);

const URI_ATTRIBUTE_PATTERN = /(URI=")((?:\\.|[^"\\])*)(")/g;

export function rewriteM3u8(content: string, baseUrl: string, resolveAlias: (absoluteUrl: string) => string): string {
  return content.split(/\r?\n/).map((rawLine) => {
    const trimmed = rawLine.trim();
    if (!trimmed || !trimmed.startsWith('#')) return trimmed ? resolveAndAlias(trimmed, baseUrl, resolveAlias) : rawLine;
    return rewriteTagAttributes(rawLine, baseUrl, resolveAlias);
  }).join('\n');
}

function rewriteTagAttributes(line: string, baseUrl: string, resolveAlias: (absoluteUrl: string) => string): string {
  const tagMatch = /^\s*#(EXT-X-[A-Z0-9-]+)/.exec(line);
  if (!tagMatch || !URI_ATTRIBUTE_TAGS.has(tagMatch[1])) return line;
  return line.replace(URI_ATTRIBUTE_PATTERN, (_match, prefix: string, rawUri: string, suffix: string) => {
    const uri = rawUri.replace(/\\(["\\])/g, '$1');
    return `${prefix}${resolveAndAlias(uri, baseUrl, resolveAlias)}${suffix}`;
  });
}

function resolveAndAlias(rawUri: string, baseUrl: string, resolveAlias: (absoluteUrl: string) => string): string {
  let resolved: URL;
  try { resolved = new URL(rawUri, baseUrl); } catch { return rawUri; }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return rawUri;
  return resolveAlias(resolved.toString());
}
