// ============================================================================
// MeshSession (§53 « origin toujours disponible » au niveau session) — Node
// n'a NI MediaSource NI RTCPeerConnection : start() doit répondre false et le
// fLoader branché doit être un PASSTHROUGH TOTAL vers l'origin-loader (le
// maillage est structurellement impossible à casser la lecture : ici on le
// prouve sans hls.js, avec le contrat de Loader respecté).
// Lancer : node --import tsx --test packages/mesh/test/session.test.mjs
// ============================================================================
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMeshToken } from '@mbolo/contracts';
import { MeshSession, createMeshSession, computeMeshRid } from '../src/mesh-session';

const SECRET = 'test-secret-mesh';
const SWARM = 'ab'.repeat(16);
const PID = 'peerA' + 'A'.repeat(17);

class FakeOriginLoader {
  constructor(config) { this.config = config; FakeOriginLoader.made += 1; }
  stats = {};
  context = null;
  load(ctx, _cfg, cb) { setTimeout(() => cb.onSuccess({ url: ctx.url, data: new Uint8Array([1, 2, 3]).buffer, code: 200 }, {}, ctx, {}), 0); }
  abort() {} destroy() {}
}
FakeOriginLoader.made = 0;

async function sessionWithToken() {
  const now = Date.now();
  const token = await createMeshToken(SECRET, { v: 1, pid: PID, sid: SWARM, did: 'cd'.repeat(16), iat: now, exp: now + 3_600_000 });
  return token;
}

describe('MeshSession — jamais bloquant, même sans environnement navigateur', () => {
  it('jeto­n illisible → createMeshSession null (le web ne monte rien)', () => {
    assert.equal(createMeshSession({ token: 'pas-un-jeton', meshUrl: 'wss://x/mesh/ws', capacity: 'off', networkType: 'wifi', iceServers: [] }), null);
  });

  it('Node (sans MSE/WebRTC) : capabilities.compatible=false, start()=false, enabled=false', async () => {
    const token = await sessionWithToken();
    const session = new MeshSession({ token, meshUrl: 'wss://x/mesh/ws', capacity: 'off', networkType: 'wifi', iceServers: [] });
    assert.equal(session.capabilities.compatible, false);
    assert.equal(await session.start(), false);
    assert.equal(session.enabled, false);
    assert.equal(session.deps(), null); // le loader ne tentera JAMAIS le mesh
  });

  it('bind() sur un Hls factice : fLoader posé puis PASSTHROUGH origin, et débranchement restaure', async () => {
    const token = await sessionWithToken();
    const session = new MeshSession({ token, meshUrl: 'wss://x/mesh/ws', capacity: 'off', networkType: 'wifi', iceServers: [] });
    const hls = { config: {} };
    const unbind = session.bind(hls, FakeOriginLoader);
    assert.equal(hls.config.fLoader, session.fLoader); // branché
    const Loader = hls.config.fLoader;
    const loader = new Loader({});
    const data = await new Promise((resolve, reject) => loader.load(
      { frag: { sn: 5, cc: 0 }, part: null, url: 'https://origin/seg5.ts', responseType: 'arraybuffer', headers: {}, rangeStart: 0, rangeEnd: 0 },
      { loadPolicy: {} },
      { onSuccess: (r) => resolve(r.data), onError: reject, onTimeout: reject, onAbort: reject },
    ));
    assert.deepEqual([...new Uint8Array(data)], [1, 2, 3]); // passé par l'origin natif
    assert.ok(FakeOriginLoader.made >= 1);
    loader.destroy();
    unbind();
    assert.equal(hls.config.fLoader, undefined); // débranché proprement (prev était undefined)
  });

  it('dispose() : le fLoader posé est retiré même sans unbind explicite', async () => {
    const token = await sessionWithToken();
    const session = new MeshSession({ token, meshUrl: 'wss://x/mesh/ws', capacity: 'off', networkType: 'wifi', iceServers: [] });
    const hls = { config: {} };
    session.bind(hls, FakeOriginLoader);
    session.dispose();
    assert.equal(hls.config.fLoader, undefined);
  });

  it('computeMeshRid est déterministe et nul sans RESOLUTION', async () => {
    const rid = await computeMeshRid({ RESOLUTION: '854x480', BANDWIDTH: '1000000', CODECS: 'avc1.4d401e' });
    assert.match(rid, /^[0-9a-f]{8}$/);
    assert.equal(rid, await computeMeshRid({ RESOLUTION: '854x480', BANDWIDTH: '1000000', CODECS: 'avc1.4d401e' }));
    assert.equal(await computeMeshRid({}), null);
    assert.notEqual(rid, await computeMeshRid({ RESOLUTION: '1280x720', BANDWIDTH: '2500000', CODECS: 'avc1.4d401f' }));
  });

  it('levelChanged/setCapacity hors-session ne lèvent jamais (le Player n’a rien à savoir)', async () => {
    const token = await sessionWithToken();
    const session = new MeshSession({ token, meshUrl: 'wss://x/mesh/ws', capacity: 'off', networkType: 'wifi', iceServers: [] });
    assert.doesNotThrow(() => session.levelChanged({ RESOLUTION: '640x360' }));
    assert.doesNotThrow(() => session.setCapacity('off'));
    await new Promise((r) => setTimeout(r, 20)); // le rid async ne doit pas rejeter en l'air
    assert.equal(session.enabled, false);
  });
});
