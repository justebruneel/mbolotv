const URI_ATTRIBUTE_TAGS = new Set(['EXT-X-KEY', 'EXT-X-MAP', 'EXT-X-PART', 'EXT-X-PRELOAD-HINT', 'EXT-X-RENDITION-REPORT', 'EXT-X-SESSION-DATA', 'EXT-X-IMAGE-STREAM-INF']);
const URI_ATTRIBUTE_PATTERN = /(URI=")((?:\\.|[^"\\])*)(")/g;

type AliasResolver = (absoluteUrl: string) => string | Promise<string>;

export async function rewriteM3u8(content: string, baseUrl: string, resolveAlias: AliasResolver): Promise<string> {
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) output.push(trimmed ? await rewriteTagAttributes(rawLine, baseUrl, resolveAlias) : rawLine);
    else output.push(await resolveAndAlias(trimmed, baseUrl, resolveAlias));
  }
  return output.join('\n');
}

async function rewriteTagAttributes(line: string, baseUrl: string, resolveAlias: AliasResolver): Promise<string> {
  const tagMatch = /^\s*#(EXT-X-[A-Z0-9-]+)/.exec(line);
  if (!tagMatch || !URI_ATTRIBUTE_TAGS.has(tagMatch[1])) return line;
  const matches = [...line.matchAll(URI_ATTRIBUTE_PATTERN)];
  if (matches.length === 0) return line;
  let output = line;
  for (const match of matches.reverse()) {
    const rawUri = match[2];
    const uri = rawUri.replace(/\\(["\\])/g, '$1');
    const rewritten = await resolveAndAlias(uri, baseUrl, resolveAlias);
    const start = match.index! + match[1].length;
    output = `${output.slice(0, start)}${rewritten}${output.slice(start + rawUri.length)}`;
  }
  return output;
}

async function resolveAndAlias(rawUri: string, baseUrl: string, resolveAlias: AliasResolver): Promise<string> {
  let resolved: URL;
  try { resolved = new URL(rawUri, baseUrl); } catch { return rawUri; }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return rawUri;
  return resolveAlias(resolved.toString());
}
