import { Readable } from 'node:stream';
import * as sax from 'sax';

export interface XmltvProgramme {
  channelId: string;
  startsAt: Date;
  endsAt: Date;
  title: string;
  description?: string;
  imageUrl?: string;
  categories: string[];
}

export interface XmltvParseResult {
  channels: number;
  programmes: number;
  stored: number;
  channelNames: Record<string, string>;
}

const DATE_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?/;
const BATCH_SIZE = 500;

function parseXmltvDate(value: string): Date | null {
  const match = DATE_RE.exec(value);
  if (!match) return null;
  const utc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  if (!match[7]) return new Date(utc);
  const offsetMinutes = Number(match[8]) * 60 + Number(match[9]);
  return new Date(utc - (match[7] === '+' ? offsetMinutes : -offsetMinutes) * 60_000);
}

export async function parseXmltvStream(
  stream: ReadableStream<Uint8Array>,
  onBatch: (programmes: XmltvProgramme[]) => Promise<number>,
): Promise<XmltvParseResult> {
  const parser = sax.createStream(true, { trim: true });

  interface OpenProgramme {
    channelId: string;
    startsAt: Date | null;
    endsAt: Date | null;
    title: string;
    description?: string;
    imageUrl?: string;
    categories: string[];
  }

  let channels = 0;
  let programmes = 0;
  let stored = 0;
  let current: OpenProgramme | null = null;
  let currentChannelId: string | null = null;
  let collecting: 'title' | 'desc' | 'category' | 'display' | null = null;
  let textBuffer = '';
  const records: XmltvProgramme[] = [];
  const channelNames = new Map<string, string>();

  let chain: Promise<void> = Promise.resolve();

  const flush = (): void => {
    if (records.length === 0) return;
    const batch = records.splice(0, records.length);
    chain = chain.then(async () => {
      const inserted = await onBatch(batch);
      stored += inserted;
    });
  };

  return new Promise<XmltvParseResult>((resolve, reject) => {
    parser.on('opentag', (node) => {
      if (node.name === 'channel') {
        channels += 1;
        currentChannelId = String(node.attributes['id'] ?? '');
        return;
      }
      if (node.name === 'programme') {
        programmes += 1;
        current = {
          channelId: String(node.attributes['channel'] ?? ''),
          startsAt: parseXmltvDate(String(node.attributes['start'] ?? '')),
          endsAt: parseXmltvDate(String(node.attributes['stop'] ?? '')),
          title: '',
          categories: [],
        };
        return;
      }
      if (node.name === 'display-name' && currentChannelId && !channelNames.has(currentChannelId)) {
        collecting = 'display';
        textBuffer = '';
        return;
      }
      if (current && node.name === 'icon' && !current.imageUrl) {
        const src = String(node.attributes['src'] ?? '').trim();
        if (src) current.imageUrl = src;
        return;
      }
      if (
        current &&
        (node.name === 'title' || node.name === 'desc' || node.name === 'category')
      ) {
        collecting = node.name;
        textBuffer = '';
      }
    });

    parser.on('text', (text) => {
      if (collecting) textBuffer += text;
    });

    parser.on('closetag', (name) => {
      if (collecting === 'display' && currentChannelId) {
        const value = textBuffer.trim();
        if (value && !channelNames.has(currentChannelId)) channelNames.set(currentChannelId, value);
        collecting = null;
        textBuffer = '';
        return;
      }
      if (current && collecting) {
        const value = textBuffer.trim();
        if (collecting === 'title') current.title = value;
        else if (collecting === 'desc') current.description = value || undefined;
        else if (collecting === 'category' && value) current.categories.push(value);
        collecting = null;
        textBuffer = '';
      }
      if (name === 'channel') {
        currentChannelId = null;
        return;
      }
      if (name === 'programme' && current) {
        const record = current;
        current = null;
        if (record.channelId && record.title && record.startsAt && record.endsAt) {
          records.push({
            channelId: record.channelId,
            startsAt: record.startsAt,
            endsAt: record.endsAt,
            title: record.title,
            description: record.description,
            imageUrl: record.imageUrl,
            categories: record.categories,
          });
          if (records.length >= BATCH_SIZE) flush();
        }
      }
    });

    parser.on('error', (error) => reject(error));
    parser.on('end', () => {
      flush();
      void chain.then(() => resolve({ channels, programmes, stored, channelNames: Object.fromEntries(channelNames) }));
    });

    try {
      Readable.fromWeb(stream as never).pipe(parser);
    } catch (error) {
      reject(error);
    }
  });
}
