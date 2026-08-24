// Parseur XMLTV minimal en streaming (équivalent xmltv.parser.ts + epg-import).
// Format : <channel id>…<display-name>…</channel>, <programme channel start stop>
// avec enfants <title>/<desc>/<category>* /<icon src>. Dates "YYYYMMDDHHMMSS +HHMM".
const DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?$/;

function parseXmltvDate(raw) {
  const match = DATE_PATTERN.exec((raw ?? '').trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, offset] = match;
  let ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second ?? '0'));
  if (offset) {
    const sign = offset[0] === '-' ? -1 : 1;
    const hours = Number(offset.slice(1, 3));
    const minutes = Number(offset.slice(3, 5));
    ms -= sign * (hours * 3_600_000 + minutes * 60_000);
  }
  return new Date(ms);
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function tagValue(chunk, tag, attributeName = null) {
  const attributeMatch = attributeName ? new RegExp(`<${tag}\\b[^>]*\\b${attributeName}="([^"]*)"[^>]*/?>`, 'i').exec(chunk) : null;
  if (attributeName) return attributeMatch?.[1];
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(chunk);
  return match ? decodeEntities(match[1].trim()) : undefined;
}

export async function parseXmltvStream(bodyStream, handlers, maxBytes = 40 * 1024 * 1024) {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';
  let received = 0;
  const reader = bodyStream.getReader();

  const drain = (final = false) => {
    // Découpe aux frontières d'éléments channel/programme complets.
    for (;;) {
      const openProgramme = buffer.indexOf('<programme');
      const nextOpen = buffer.indexOf('<', openProgramme + 1);
      if (openProgramme === -1 && !buffer.includes('<channel')) break;
      let consumed = false;
      const programmeEnd = buffer.indexOf('</programme>');
      if (programmeEnd !== -1) {
        const chunk = buffer.slice(0, programmeEnd + '</programme>'.length);
        buffer = buffer.slice(programmeEnd + '</programme>'.length);
        handleProgramme(chunk, handlers);
        consumed = true;
      } else if (!final) {
        const closeChannel = buffer.indexOf('</channel>');
        if (closeChannel !== -1) {
          const chunk = buffer.slice(0, closeChannel + '</channel>'.length);
          buffer = buffer.slice(closeChannel + '</channel>'.length);
          handleChannel(chunk, handlers);
          consumed = true;
        }
      }
      if (!consumed) {
        // Garde une fenêtre glissante pour éviter l'expansion mémoire.
        if (buffer.length > 256 * 1024 && !final) {
          const safeCut = Math.max(buffer.lastIndexOf('>', buffer.length - 128 * 1024) + 1, 0);
          if (safeCut > 0) { buffer = buffer.slice(safeCut); continue; }
        }
        break;
      }
      void nextOpen;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error('EPG trop volumineux'); }
    buffer += decoder.decode(value, { stream: true });
    drain(false);
  }
  buffer += decoder.decode();
  drain(true);
}

function handleChannel(chunk, handlers) {
  const id = /\b(?:id|xmltv-id)="([^"]*)"/i.exec(chunk)?.[1];
  if (!id) return;
  const name = tagValue(chunk, 'display-name') ?? '';
  handlers.onChannel?.({ id: decodeEntities(id.trim()), name });
}

function handleProgramme(chunk, handlers) {
  const attributes = /<programme\b([^>]*)>/i.exec(chunk)?.[1] ?? '';
  const channelId = /\bchannel="([^"]*)"/i.exec(attributes)?.[1];
  const startRaw = /\bstart="([^"]*)"/i.exec(attributes)?.[1];
  const stopRaw = /\bstop="([^"]*)"/i.exec(attributes)?.[1];
  const startsAt = parseXmltvDate(startRaw);
  const endsAt = parseXmltvDate(stopRaw);
  const title = tagValue(chunk, 'title');
  if (!channelId || !title || !startsAt || !endsAt) return;
  const description = tagValue(chunk, 'desc') ?? null;
  const icon = tagValue(chunk, 'icon', 'src');
  const categories = [];
  const categoryPattern = /<category\b[^>]*>([\s\S]*?)<\/category>/gi;
  let match;
  while ((match = categoryPattern.exec(chunk)) !== null) categories.push(decodeEntities(match[1].trim()));
  handlers.onProgramme({
    channelId: decodeEntities(channelId.trim()),
    title,
    description,
    startsAt,
    endsAt,
    categories,
    imageUrl: icon ?? undefined,
  });
}
