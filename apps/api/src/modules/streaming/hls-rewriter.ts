const URI_ATTRIBUTE_TAGS = new Set([
  'EXT-X-KEY',
  'EXT-X-MAP',
  'EXT-X-PART',
  'EXT-X-SESSION-DATA',
]);

const URI_ATTRIBUTE_PATTERN = /(URI=")((?:\\.|[^"\\])*)(")/g;

export function rewriteM3u8(
  content: string,
  baseUrl: string,
  resolveAlias: (absoluteUrl: string) => string,
): string {
  const lines = content.split(/\r?\n/);
  const output: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine;
    const trimmed = line.trim();

    if (trimmed.startsWith('#EXT-X-STREAM-INF')) {
      output.push(line);
      continue;
    }

    if (trimmed.startsWith('#')) {
      output.push(rewriteTagAttributes(trimmed, baseUrl, resolveAlias));
      continue;
    }

    if (trimmed.length > 0) {
      output.push(resolveAndAlias(trimmed, baseUrl, resolveAlias));
      continue;
    }

    output.push(line);
  }

  return output.join('\n');
}

function rewriteTagAttributes(
  line: string,
  baseUrl: string,
  resolveAlias: (absoluteUrl: string) => string,
): string {
  const tagMatch = /^#(EXT-X-[A-Z-]+)/.exec(line);
  if (!tagMatch) return line;
  if (!URI_ATTRIBUTE_TAGS.has(tagMatch[1])) return line;

  return line.replace(URI_ATTRIBUTE_PATTERN, (_match, prefix, rawUri, suffix) => {
    const uri = rawUri.replace(/\\(["\\])/g, '$1');
    return `${prefix}${resolveAndAlias(uri, baseUrl, resolveAlias)}${suffix}`;
  });
}

function resolveAndAlias(
  rawUri: string,
  baseUrl: string,
  resolveAlias: (absoluteUrl: string) => string,
): string {
  let resolved: URL;
  try {
    resolved = new URL(rawUri, baseUrl);
  } catch {
    return rawUri;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return rawUri;
  }
  return resolveAlias(resolved.toString());
}
