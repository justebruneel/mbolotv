const URI_ATTRIBUTE_TAGS = new Set(['EXT-X-KEY', 'EXT-X-MAP', 'EXT-X-PART', 'EXT-X-PRELOAD-HINT', 'EXT-X-RENDITION-REPORT', 'EXT-X-SESSION-DATA', 'EXT-X-IMAGE-STREAM-INF']);
const URI_ATTRIBUTE_PATTERN = /(URI=")((?:\\.|[^"\\])*)(")/g;
const REWRITE_CONCURRENCY = 8;

type AliasResolver = (absoluteUrl: string) => string | Promise<string>;
type AliasMemo = Map<string, Promise<string>>;

export async function rewriteM3u8(content: string, baseUrl: string, resolveAlias: AliasResolver): Promise<string> {
  const lines = content.split(/\r?\n/);
  const memo: AliasMemo = new Map();
  const output = new Array<string>(lines.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= lines.length) return;
      const rawLine = lines[index];
      const trimmed = rawLine.trim();
      output[index] = !trimmed || trimmed.startsWith('#')
        ? trimmed ? await rewriteTagAttributes(rawLine, baseUrl, resolveAlias, memo) : rawLine
        : await resolveAndAlias(trimmed, baseUrl, resolveAlias, memo);
    }
  };
  await Promise.all(Array.from({ length: Math.min(REWRITE_CONCURRENCY, Math.max(1, lines.length)) }, () => worker()));
  return output.join('\n');
}

async function rewriteTagAttributes(line: string, baseUrl: string, resolveAlias: AliasResolver, memo: AliasMemo): Promise<string> {
  const tagMatch = /^\s*#(EXT-X-[A-Z0-9-]+)/.exec(line);
  if (!tagMatch || !URI_ATTRIBUTE_TAGS.has(tagMatch[1])) return line;
  const matches = [...line.matchAll(URI_ATTRIBUTE_PATTERN)];
  if (matches.length === 0) return line;
  const rewritten = await Promise.all(matches.map(async (match) => {
    const rawUri = match[2];
    const uri = rawUri.replace(/\\(["\\])/g, '$1');
    return resolveAndAlias(uri, baseUrl, resolveAlias, memo);
  }));
  let output = line;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    const start = match.index! + match[1].length;
    output = `${output.slice(0, start)}${rewritten[index]}${output.slice(start + match[2].length)}`;
  }
  return output;
}

async function resolveAndAlias(rawUri: string, baseUrl: string, resolveAlias: AliasResolver, memo: AliasMemo): Promise<string> {
  let resolved: URL;
  try { resolved = new URL(rawUri, baseUrl); } catch { return rawUri; }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return rawUri;
  const absoluteUrl = resolved.toString();
  const existing = memo.get(absoluteUrl);
  if (existing) return existing;
  const pending = Promise.resolve(resolveAlias(absoluteUrl));
  memo.set(absoluteUrl, pending);
  return pending;
}
