// ============================================================================
// Instrumentation canary (étape 6) — collecteur borné, corrélation tid et
// garde-fou anti-fuite. SANS navigateur : les événements sont construits à la
// main ; la corrélation A↔B est vérifiée par jointure sur `tid` (nonce partagé).
// Lancer : node --import tsx --test packages/mesh/test/mesh-trace-canary.test.mjs
// ============================================================================
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMeshTraceCollector,
  findMeshTraceLeak,
  assertMeshTracePrivacy,
  meshSegmentId,
  classifyDeviceClass,
} from '../src/trace.ts';

describe('collecteur borné', () => {
  it('enrichit at/rel et borne à maxEvents (dropped compté)', () => {
    let t = 1000;
    const c = createMeshTraceCollector({ maxEvents: 100, now: () => t, console: false });
    for (let i = 0; i < 150; i += 1) { t += 10; c.trace({ t: 'tier', cc: 0, sn: i, tier: 'origin', ms: 5 }); }
    assert.equal(c.size(), 100);
    assert.equal(c.dropped(), 50);
    const evts = c.events();
    assert.equal(evts[0].sn, 50); // les plus anciens écartés, les récents gardés
    assert.ok(evts[0].at >= 1000 && evts[0].rel >= 0);
    assert.ok(evts[evts.length - 1].rel > evts[0].rel);
  });
  it('clear() vide le buffer', () => {
    const c = createMeshTraceCollector({ console: false });
    c.trace({ t: 'kill', enabled: false });
    assert.equal(c.size(), 1);
    c.clear();
    assert.equal(c.size(), 0);
    assert.equal(c.dropped(), 0);
  });
  it('le traceur ne jette jamais (console absente, événement tordu)', () => {
    const c = createMeshTraceCollector({ console: false });
    assert.doesNotThrow(() => c.trace({ t: 'error', where: 'x', message: 'y' }));
  });
});

describe('corrélation A↔B par tid', () => {
  it('deux transferts req/srv partagent tid + (cc,sn) et se joignent', () => {
    const c = createMeshTraceCollector({ console: false });
    const tid = 'AbCdEfGhIjKlMnOp';
    c.trace({ t: 'transfer', tid, pid: 'peerAAAAAAAAAAAAAAAAAA', role: 'srv', cc: 3, sn: 42, ok: true, bytes: 512000, ms: 120 });
    c.trace({ t: 'transfer', tid, pid: 'peerBBBBBBBBBBBBBBBBBB', role: 'req', cc: 3, sn: 42, ok: true, bytes: 512000, ms: 210 });
    const byTid = new Map();
    for (const e of c.events()) {
      if (e.t !== 'transfer') continue;
      if (!byTid.has(e.tid)) byTid.set(e.tid, []);
      byTid.get(e.tid).push(e);
    }
    const pair = byTid.get(tid);
    assert.equal(pair.length, 2);
    assert.ok(pair.some((e) => e.role === 'req') && pair.some((e) => e.role === 'srv'));
    assert.ok(pair.every((e) => e.cc === 3 && e.sn === 42 && e.bytes === 512000));
  });
  it('meshSegmentId = swarm8:cc:sn (jamais une URL)', () => {
    assert.equal(meshSegmentId('ab12cd34', 1, 99), 'ab12cd34:1:99');
    assert.ok(!meshSegmentId('ab12cd34', 1, 99).includes('http'));
  });
});

describe('garde-fou anti-fuite', () => {
  it('événements sains → aucun leak', () => {
    const healthy = [
      { t: 'ice', pid: 'peerAAAAAAAAAAAAAAAAAA', ms: 12, state: { ice: 'connected', gathering: 'complete', connection: 'connected' } },
      { t: 'candidatePair', pid: 'peerAAAAAAAAAAAAAAAAAA', local: 'host', remote: 'srflx' },
      { t: 'dc', pid: 'peerAAAAAAAAAAAAAAAAAA', state: 'open' },
      { t: 'hello', pid: 'peerAAAAAAAAAAAAAAAAAA', ok: true },
      { t: 'transfer', tid: 'AbCdEfGhIjKlMnOp', pid: 'peerAAAAAAAAAAAAAAAAAA', role: 'req', cc: 0, sn: 7, ok: true, bytes: 100, ms: 50 },
      { t: 'tier', cc: 0, sn: 7, tier: 'peer', ms: 50 },
      { t: 'fallback', cc: 0, sn: 8, reason: 'timeout', ms: 1500 },
      { t: 'session', sid8: 'ab12cd34', pid: 'peerAAAAAAAAAAAAAAAAAA', proto: 1, cap: 'normal', net: 'wifi', deviceClass: 'desktop', visibility: 'foreground', peers: 1 },
      { t: 'stall', durMs: 1200, bufferSec: 1.5 },
      { t: 'kill', enabled: false },
    ];
    for (const e of healthy) assert.equal(findMeshTraceLeak(e), null, JSON.stringify(e));
  });
  it('token / url / ip / deviceId / cookie → leak détecté', () => {
    assert.ok(findMeshTraceLeak({ t: 'error', where: 'x', message: 'https://fournisseur/seg.ts' }));
    assert.ok(findMeshTraceLeak({ t: 'tier', cc: 0, sn: 1, tier: 'peer', ms: 1, url: 'https://x' }));
    assert.ok(findMeshTraceLeak({ token: 'abc' }));
    assert.ok(findMeshTraceLeak({ t: 'ice', pid: 'p', ms: 1, state: { ice: 'connected' }, deviceId: 'd' }));
    assert.ok(findMeshTraceLeak({ t: 'candidatePair', pid: 'p', local: '192.168.1.10', remote: 'host' }));
    assert.ok(findMeshTraceLeak({ t: 'session', sid8: 'ab12cd34', pid: 'p', proto: 1, cap: 'off', net: 'wifi', deviceClass: 'desktop', visibility: 'foreground', peers: 0, email: 'a@b.c' }));
  });
  it('assertMeshTracePrivacy lève sur fuite, pas sur événement sain', () => {
    assert.doesNotThrow(() => assertMeshTracePrivacy({ t: 'kill', enabled: true }));
    assert.throws(() => assertMeshTracePrivacy({ t: 'kill', enabled: true, token: 'x' }));
  });
});

describe('classifyDeviceClass — grossier et non personnel', () => {
  it('desktop / mobile / tv / webview / unknown', () => {
    assert.equal(classifyDeviceClass('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'desktop');
    assert.equal(classifyDeviceClass('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit Mobile'), 'mobile');
    assert.equal(classifyDeviceClass('Mozilla/5.0 (Linux; Android 11; Android TV) Cobalt'), 'tv');
    assert.equal(classifyDeviceClass('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit; wv) Version/4.0'), 'webview');
    assert.equal(classifyDeviceClass(''), 'unknown');
  });
});
