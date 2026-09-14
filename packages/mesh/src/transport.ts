// Trames binaires du protocole peer-to-peer (spec §6.3) : en-tête 7 octets
// [version(1) | bid(4 BE) | chunkIdx(2 BE)] suivi des octets du segment.
// `bid` (uint32) associe la trame à la requête SEGMENT_HEADER en cours sur un
// canal partagé ; `chunkIdx` force l'ordre (canal ordonné — un écart = ERROR).
import { MESH_PROTOCOL_VERSION } from '@mbolo/contracts';

export const FRAME_HEADER_BYTES = 7;

/** Découpe un segment en trames binaires prêtes à dc.send(). Les Uint8Array
 *  sont des buffers frais (non partagés) — exigence RTCDataChannel.send. */
export function splitFrames(bytes: Uint8Array, bid: number, chunkBytes: number): Uint8Array<ArrayBuffer>[] {
  if (chunkBytes < 16_384) throw new Error('chunkBytes hors bornes');
  const frames: Uint8Array<ArrayBuffer>[] = [];
  for (let idx = 0, at = 0; at < bytes.length; idx += 1, at += chunkBytes) {
    const end = Math.min(at + chunkBytes, bytes.length);
    const frame = new Uint8Array(FRAME_HEADER_BYTES + end - at);
    frame[0] = MESH_PROTOCOL_VERSION;
    new DataView(frame.buffer).setUint32(1, bid >>> 0, false);
    frame[5] = (idx >> 8) & 0xff;
    frame[6] = idx & 0xff;
    frame.set(bytes.subarray(at, end), FRAME_HEADER_BYTES);
    frames.push(frame);
  }
  return frames;
}

export interface DecodedFrame { version: number; bid: number; idx: number; payload: Uint8Array }

export function decodeFrame(raw: ArrayBuffer | Uint8Array): DecodedFrame | null {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.length < FRAME_HEADER_BYTES + 1 || bytes.length > 65_536 + FRAME_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { version: bytes[0], bid: view.getUint32(1, false), idx: (bytes[5] << 8) | bytes[6], payload: bytes.subarray(FRAME_HEADER_BYTES) };
}
