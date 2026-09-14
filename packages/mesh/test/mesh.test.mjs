// ============================================================================
// Tests unitaires @mbolo/mesh (étape 4) — SANS navigateur : mocks minimaux ;
// le hash SHA-256 vient de la WebCrypto native Node ≥ 19. Ils figent les
// règles de la POC : cache borné, protocole strict, loader opportuniste,
// transport WS→poll→dead. (Les tests de transport complet A↔B avec liens
// simulés sont dans peer-transport.test.mjs.)
// Lancer : node --import tsx --test packages/mesh/test/*.test.mjs
// ============================================================================
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SegmentCache, sha256Hex } from '../src/memory-cache.ts';
import { decodeFrame, splitFrames, FRAME_HEADER_BYTES } from '../src/transport.ts';
import { MeshLoader } from '../src/mesh-loader.ts';
import { Signaling, derivePollBase } from '../src/signaling.ts';
import { detectMeshCapabilities, defaultCapacityFor } from '../src/capabilities.ts';

const SWARM = 'ab'.repeat(16);

// ------------------------------------------------------------------ transport

describe('transport — trames binaires', () => {
  it('aller-retour header+payload fidèle', () => {
    const bytes = new Uint8Array(200000); // > chunkBytes : multi-trames
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i & 0xff;
    const frames = splitFrames(bytes, 7, 65536);
    assert.equal(frames.length, Math.ceil(bytes.length / 65536));
    const rebuilt = new Uint8Array(bytes.length);
    let at = 0;
    for (const frame of frames) {
      const d = decodeFrame(frame);
      assert.ok(d);
      assert.equal(d.bid, 7);
      rebuilt.set(d.payload, at);
      at += d.payload.length;
    }
    assert.deepEqual(rebuilt, bytes);
    assert.equal(at, bytes.length);
  });
  it('trame trop courte ou trop grosse = null (garde d’entrée)', () => {
    assert.equal(decodeFrame(new Uint8Array(5)), null);
    assert.equal(decodeFrame(new Uint8Array(FRAME_HEADER_BYTES)), null);
    assert.equal(decodeFrame(new Uint8Array(65536 + FRAME_HEADER_BYTES + 1)), null);
  });
  it('le chunkIdx est croissant et la version est celle du protocole', () => {
    const frames = splitFrames(new Uint8Array(150000), 42, 65536);
    frames.forEach((frame, idx) => {
      const d = decodeFrame(frame);
      assert.equal(d.version, 1);
      assert.equal(d.idx, idx);
    });
  });
});

// -------------------------------------------------------------------- cache

describe('SegmentCache — bornes strictes', () => {
  it('hit/miss/éviction LRU (jamais de croissance infinie)', async () => {
    const cache = new SegmentCache(SWARM, 3);
    await cache.put(0, 10, new Uint8Array([1]), 'origin');
    await cache.put(0, 11, new Uint8Array([2]), 'origin');
    await cache.put(0, 12, new Uint8Array([3]), 'peer');
    assert.equal(cache.size, 3);
    // LRU : un hit sur le plus ancien le rafraîchit → la victime devient 11.
    assert.ok(cache.get(0, 10));
    await cache.put(0, 13, new Uint8Array([4]), 'origin');
    assert.equal(cache.size, 3);
    assert.ok(cache.has(0, 10)); // touché par get → survit
    assert.equal(cache.has(0, 11), false); // le vrai plus ancien → évincé
    assert.ok(cache.has(0, 13));
  });
  it('la fenêtre annoncée reste dans un MÊME cc (discontinuité = césure)', async () => {
    const cache = new SegmentCache(SWARM, 30);
    for (const pair of [[0, 5], [0, 6], [1, 7], [1, 8]]) await cache.put(pair[0], pair[1], new Uint8Array([pair[0], pair[1]]), 'origin');
    const win = cache.window(20);
    assert.ok(win);
    assert.equal(win.cc, 1);
    assert.deepEqual([win.first, win.last], [7, 8]);
  });
  it('clé = (swarmId, cc, sn), pas l’URL', async () => {
    const cache = new SegmentCache(SWARM, 10);
    await cache.put(0, 5, new Uint8Array([1]), 'origin');
    await cache.put(1, 5, new Uint8Array([2]), 'origin');
    assert.ok(cache.get(0, 5));
    assert.ok(cache.get(1, 5));
  });
  it('sha256Hex est le SHA-256 standard', async () => {
    assert.equal(await sha256Hex(new Uint8Array([97, 98, 99])), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

// -------------------------------------------------------------- capabilities

describe('capabilities — gating structurel', () => {
  it('tout présent → compatible ; un manquant → false', () => {
    const full = detectMeshCapabilities({ MediaSource: { isSupported: () => true }, RTCPeerConnection: function () {}, RTCDataChannel: {}, crypto: globalThis.crypto, fetch: () => {} });
    assert.equal(full.compatible, true);
    assert.equal(detectMeshCapabilities({}).compatible, false);
    assert.equal(detectMeshCapabilities({ MediaSource: { isSupported: () => false } }).compatible, false);
    assert.equal(detectMeshCapabilities({ MediaSource: { isSupported: () => true }, crypto: globalThis.crypto, fetch: () => {} }).compatible, false); // pas de WebRTC
  });
  it('POC : PERSONNE ne seede par défaut (§39 consentement)', () => {
    assert.equal(defaultCapacityFor('Mozilla/5.0 (X11; Linux)', false, 'wifi'), 'off');
    assert.equal(defaultCapacityFor('Android TV', false, 'wired'), 'off');
  });
});

// ---------------------------------------------------------------- signaling

describe('Signaling — WS privilégié, poll en repli, dead ensuite', () => {
  it('dérive pollBase depuis meshUrl', () => {
    assert.equal(derivePollBase('https://mesh.dev/mesh/ws'), 'https://mesh.dev/mesh');
    assert.equal(derivePollBase('https://mesh.dev/mesh/ws/'), 'https://mesh.dev/mesh');
  });

  function failingWsFactory(counter) {
    return () => {
      counter.calls += 1;
      const listeners = new Map();
      const fake = {
        readyState: 0, send() {}, close() {},
        addEventListener(type, listener) { listeners.set(type, listener); },
      };
      setTimeout(() => listeners.get('close') && listeners.get('close')(), 0);
      return fake;
    };
  }

  it('3 échecs WS → bascule polling (statut + transport)', async () => {
    const counter = { calls: 0 };
    const statuses = [];
    const sig = new Signaling({
      meshUrl: 'wss://mesh.dev/mesh/ws', token: 'tok', pollBase: 'https://mesh.dev/mesh',
      reconnect: true, backoffMaxMs: 5,
      wsFactory: failingWsFactory(counter),
      fetchImpl: async () => ({ ok: true, json: async () => ({ cursor: 0, events: [] }) }),
      now: () => 1,
    });
    sig.onStatus((s) => statuses.push(s));
    sig.connect();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(sig.transport, 'poll');
    assert.ok(statuses.includes('polling'));
    sig.close();
  });

  it('polling qui meurt → dead (la session mesh se coupe, pas la lecture)', async () => {
    const counter = { calls: 0 };
    const statuses = [];
    const sig = new Signaling({
      meshUrl: 'wss://mesh.dev/mesh/ws', token: 'tok', pollBase: 'https://mesh.dev/mesh',
      reconnect: true, backoffMaxMs: 5,
      wsFactory: failingWsFactory(counter),
      fetchImpl: async () => { throw new Error('no network'); },
      now: () => 1,
    });
    sig.onStatus((s) => statuses.push(s));
    sig.connect();
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(statuses.includes('dead'), `statuses=${statuses}`);
    sig.close();
  });

  it('send après dead = no-op silencieux (le loader retombe origin)', async () => {
    const sig = new Signaling({
      meshUrl: 'wss://m/ws', token: 't', pollBase: 'https://m', reconnect: true, backoffMaxMs: 1,
      wsFactory: failingWsFactory({ calls: 0 }),
      fetchImpl: async () => { throw new Error('down'); },
      now: () => 1,
    });
    sig.connect();
    await new Promise((r) => setTimeout(r, 300));
    assert.doesNotThrow(() => sig.send(JSON.stringify({ v: 1 })));
    sig.close();
  });
});

// ------------------------------------------------------------------- loader

function fakeOrigin() {
  return {
    stats: null, context: null,
    load(ctx, _config, callbacks) {
      setTimeout(() => callbacks.onSuccess(
        { url: ctx.url, data: new Uint8Array([0xde, 0xad]).buffer, code: 200 },
        {}, ctx, {}), 0);
    },
    abort() {}, destroy() {},
  };
}

function fakeLoaderDeps(overrides) {
  const calls = { cacheHit: 0, origin: 0 };
  const deps = Object.assign({
    makeOrigin: () => fakeOrigin(),
    allowed: () => true,
    started: () => true,
    bufferOk: () => true,
    liveEdgeOk: () => true,
    cacheGet: () => null,
    cacheSeed: () => undefined,
    requestSegment: async () => ({ ok: false, reason: 'dead' }),
    metrics: {
      cacheHit() { calls.cacheHit += 1; },
      origin() { calls.origin += 1; },
    },
  }, overrides);
  return { deps, calls };
}

const CONTEXT = (sn, cc = 0, extra) => ({ frag: Object.assign({ sn, cc }, extra), part: null, responseType: 'arraybuffer', url: `https://proxy/seg-${sn}.ts`, headers: {}, rangeStart: 0, rangeEnd: 0 });

function load(loader, ctx) {
  return new Promise((resolve) => loader.load(ctx, {}, {
    onSuccess: (response) => resolve(new Uint8Array(response.data)),
    onError: () => resolve(new Error('loader-error')),
    onTimeout: () => resolve(new Error('loader-timeout')),
  }));
}

describe('MeshLoader — jamais bloquant, toujours opportuniste (§51)', () => {
  it('CAS 1 cache hit : ni pair, ni origin', async () => {
    let asked = 0;
    const { deps, calls } = fakeLoaderDeps({ cacheGet: () => new Uint8Array([1, 2, 3]), requestSegment: async () => { asked += 1; return { ok: false }; } });
    const loader = new MeshLoader(deps, {});
    const delivered = await load(loader, CONTEXT(50));
    assert.deepEqual([...delivered], [1, 2, 3]);
    assert.equal(calls.cacheHit, 1);
    assert.equal(asked, 0);
  });
  it('CAS 2 pair prêt : bytes du pair livrés + seed', async () => {
    const seeds = [];
    const { deps } = fakeLoaderDeps({ requestSegment: async () => ({ ok: true, bytes: new Uint8Array([9, 9]) }), cacheSeed: (cc, sn) => seeds.push([cc, sn]) });
    const loader = new MeshLoader(deps, {});
    const delivered = await load(loader, CONTEXT(51));
    assert.deepEqual([...delivered], [9, 9]);
    assert.deepEqual(seeds, [[0, 51]]);
  });
  it('CAS 3 timeout pair → origin', async () => {
    const { deps, calls } = fakeLoaderDeps({ requestSegment: async () => ({ ok: false, reason: 'timeout' }) });
    const loader = new MeshLoader(deps, {});
    const delivered = await load(loader, CONTEXT(52));
    assert.deepEqual([...delivered], [0xde, 0xad]);
    assert.equal(calls.origin, 1);
  });
  it('CAS 4 buffer critique → origin SANS interroger les pairs', async () => {
    let asked = 0;
    const { deps } = fakeLoaderDeps({ bufferOk: () => false, requestSegment: async () => { asked += 1; return { ok: false }; } });
    const loader = new MeshLoader(deps, {});
    await load(loader, CONTEXT(53));
    assert.equal(asked, 0);
  });
  it('CAS 5 mesh pas prêt (allowed=false) → origin direct', async () => {
    let asked = 0;
    const { deps } = fakeLoaderDeps({ allowed: () => false, requestSegment: async () => { asked += 1; return { ok: false }; } });
    const loader = new MeshLoader(deps, {});
    const delivered = await load(loader, CONTEXT(54));
    assert.equal(asked, 0);
    assert.deepEqual([...delivered], [0xde, 0xad]);
  });
  it('CAS 6 hash invalide → origin', async () => {
    const { deps, calls } = fakeLoaderDeps({ requestSegment: async () => ({ ok: false, reason: 'hash' }) });
    const loader = new MeshLoader(deps, {});
    await load(loader, CONTEXT(55));
    assert.equal(calls.origin, 1);
  });
  it('init segment (sn string) et segment chiffré → jamais le mesh', async () => {
    let asked = 0;
    const { deps } = fakeLoaderDeps({ requestSegment: async () => { asked += 1; return { ok: false }; } });
    const loader = new MeshLoader(deps, {});
    await load(loader, { frag: { sn: 'initSegment', cc: 0 }, part: null, responseType: 'arraybuffer', url: 'u', headers: {}, rangeStart: 0, rangeEnd: 0 });
    await load(loader, CONTEXT(5, 0, { encrypted: true }));
    await load(loader, { frag: { sn: 6, cc: 0, decryptdata: {} }, part: null, responseType: 'arraybuffer', url: 'u', headers: {}, rangeStart: 0, rangeEnd: 0 });
    assert.equal(asked, 0);
  });
  it('live edge trop proche → origin sans requête pair', async () => {
    let asked = 0;
    const { deps } = fakeLoaderDeps({ liveEdgeOk: (_cc, sn) => sn < 100, requestSegment: async () => { asked += 1; return { ok: false }; } });
    const loader = new MeshLoader(deps, {});
    await load(loader, CONTEXT(101));
    assert.equal(asked, 0);
  });
  it('abort pendant l’attente pair : la réponse du pair abandonné ne livre JAMAIS', async () => {
    const resolvers = [];
    const { deps } = fakeLoaderDeps({ requestSegment: () => new Promise((r) => resolvers.push(r)) });
    const loader = new MeshLoader(deps, {});
    let firstSuccess = 0;
    loader.load(CONTEXT(60), {}, { onSuccess: () => { firstSuccess += 1; }, onError: () => {}, onTimeout: () => {} });
    loader.abort();
    resolvers[0]({ ok: true, bytes: new Uint8Array([1]) });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(firstSuccess, 0); // livraison post-abort = double append MSE interdit
  });
  it('origin → seed (A reçoit de origin, A cache, A annoncera)', async () => {
    const seeds = [];
    const { deps } = fakeLoaderDeps({ cacheSeed: (cc, sn, bytes) => seeds.push([cc, sn, bytes.length]) });
    const loader = new MeshLoader(deps, {});
    await load(loader, CONTEXT(70));
    assert.deepEqual(seeds, [[0, 70, 2]]);
  });
  it('un segment manquant au pair ne fait JAMAIS échouer la lecture (origin prend)', async () => {
    const { deps } = fakeLoaderDeps({ requestSegment: async () => ({ ok: false, reason: 'refused' }) });
    const loader = new MeshLoader(deps, {});
    const delivered = await load(loader, CONTEXT(80));
    assert.deepEqual([...delivered], [0xde, 0xad]);
  });
});
