// End-to-end behaviour of the gateway handler against fake nginx, a fake internal socket and a
// fake api. The peer is injected (contract §6: tests inject peerOf; production uses the socket).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DIRECT_OFF, INGRESS_PEER, socketPeer } from '../src/gateway.js';
import { haSessionStore, json, request, startFakeApi, startFakeInternal, startFakeNginx, startGateway, TOKEN } from './helpers/servers.js';

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });
const track = x => { cleanups.push(x.close); return x; };

const HA_ID = '8f2b9c3e4d5a6b7c8d9e0f1a2b3c4d5e';
const latin1 = s => Buffer.from(s, 'utf8').toString('latin1'); // UTF-8 bytes as node will read them
const cookiePairs = cookie => String(cookie || '').split(';').map(s => s.trim()).filter(Boolean);
const remoteUserHeaders = h => Object.keys(h).filter(k => k.startsWith('x-remote-user-'));

async function setup({ peer = INGRESS_PEER, directAccess = false, internalHandlers = null, store = haSessionStore(), nginx = {}, api = null } = {}) {
  const web = track(await startFakeNginx(nginx));
  const internal = track(await startFakeInternal(internalHandlers || {
    'POST /internal/ha-session': store.handler,
    'GET /internal/users': async () => [200, { users: store.users }],
  }));
  const fakeApi = api ? track(await startFakeApi(api)) : null;
  const gw = track(await startGateway({
    peer, socketPath: internal.socketPath,
    config: { directAccess, webUrl: web.url, ...(fakeApi ? { apiUrl: fakeApi.url } : {}) },
  }));
  return { web, internal, gw, store, fakeApi };
}

const FORGED = [
  ['X-Remote-User-Id', HA_ID], ['X-Remote-User-Name', 'admin'], ['X-Remote-User-Display-Name', 'Admin'],
  ['X-Remote-User-Is-Admin', 'true'],
];

test('non-ingress peer with direct access on: forged X-Remote-User-* never yields a session and never reaches upstream', async () => {
  const { web, internal, gw } = await setup({ peer: '172.30.32.1', directAccess: true });
  const r = await request(gw.url, { path: '/api/me', headers: [...FORGED, ['Cookie', 'gymsid=client-own'], ['Authorization', 'Bearer phone']] });
  assert.equal(r.status, 200);
  assert.equal(internal.calls.length, 0, 'no ha-session call for a non-ingress peer');
  assert.equal(web.seen.length, 1);
  const h = web.seen[0].headers;
  assert.deepEqual(remoteUserHeaders(h), [], 'no X-Remote-User-* header at all upstream');
  // Direct access is upstream's own sign-in: the client's credentials pass untouched.
  assert.equal(h.cookie, 'gymsid=client-own');
  assert.equal(h.authorization, 'Bearer phone');
});

test('a peer inside the hassio /23 but not exactly 172.30.32.2 is not ingress', async () => {
  for (const peer of ['172.30.32.1', '172.30.33.2', '172.30.32.20', '172.30.32.3', '127.0.0.1']) {
    const { web, internal, gw } = await setup({ peer, directAccess: true });
    await request(gw.url, { path: '/api/data', headers: FORGED });
    assert.equal(internal.calls.length, 0, peer);
    assert.deepEqual(remoteUserHeaders(web.seen[0].headers), [], peer);
  }
});

test('the production peer is the socket address with ::ffff: removed', () => {
  assert.equal(socketPeer({ socket: { remoteAddress: '::ffff:172.30.32.2' } }), '172.30.32.2');
  assert.equal(socketPeer({ socket: { remoteAddress: '172.30.32.2' } }), '172.30.32.2');
  assert.equal(socketPeer({ socket: { remoteAddress: '::1' } }), '::1');
  assert.equal(INGRESS_PEER, '172.30.32.2');
});

test('direct access off: 403 for everything except /healthz and /ha/v1/*', async () => {
  const { web, internal, gw } = await setup({ peer: '192.168.1.50', directAccess: false, api: {
    'GET /api/health': async () => [200, { ok: true, users: 1, writable: true }],
  } });
  for (const [method, path] of [['GET', '/'], ['GET', '/index.html'], ['GET', '/api/me'], ['POST', '/api/register/options'],
    ['GET', '/ha/v1x'], ['GET', '/healthz/'], ['GET', '/exercise-media/x.webp']]) {
    const r = await request(gw.url, { method, path, headers: FORGED });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.deepEqual(json(r), DIRECT_OFF);
  }
  assert.equal(web.seen.length, 0, 'nothing reached nginx');
  assert.equal(internal.calls.length, 0);
  assert.equal((await request(gw.url, { path: '/healthz' })).status, 200);
  assert.equal((await request(gw.url, { path: '/ha/v1/health' })).status, 200);
  assert.equal((await request(gw.url, { path: '/ha/v1/profiles', headers: [['Authorization', `Bearer ${TOKEN}`]] })).status, 200);
});

test('ingress without identity: client session cookies and Authorization are stripped, other cookies kept, no internal call', async () => {
  const { web, internal, gw } = await setup();
  for (const path of ['/api/me', '/assets/index.js']) {
    await request(gw.url, { path, headers: [
      ['Cookie', 'theme=dark; gymsid=direct-port-session; __Host-gymsid=other'], ['Cookie', 'gymsid=dupe'],
      ['Authorization', 'Bearer stolen'],
    ] });
  }
  assert.equal(internal.calls.length, 0);
  for (const seen of web.seen) {
    assert.equal(seen.headers.cookie, 'theme=dark');
    assert.equal(seen.headers.authorization, undefined);
  }
});

test('ingress with identity on /api/*: exactly one gymsid, the minted token', async () => {
  const { web, internal, gw } = await setup();
  const r = await request(gw.url, { path: '/api/me', headers: [
    ['X-Remote-User-Id', HA_ID], ['X-Remote-User-Name', 'alex'], ['X-Remote-User-Display-Name', 'Alex'],
    ['Cookie', 'theme=dark; gymsid=forged; __Host-gymsid=forged2'], ['Authorization', 'Bearer forged'],
  ] });
  assert.equal(r.status, 200);
  assert.deepEqual(internal.calls, [{ key: 'POST /internal/ha-session', body: { ha_user_id: HA_ID, name: 'Alex' } }]);
  const h = web.seen[0].headers;
  const pairs = cookiePairs(h.cookie);
  assert.deepEqual(pairs.filter(p => /^(__Host-)?gymsid=/.test(p)), ['gymsid=tok-u1']);
  assert.ok(pairs.includes('theme=dark'));
  assert.equal(h.authorization, undefined, 'never a Bearer');
  assert.deepEqual(remoteUserHeaders(h), []);
});

test('ingress with identity on a static path: no internal call, no session', async () => {
  const { web, internal, gw } = await setup();
  for (const path of ['/', '/index.html', '/assets/app.js', '/exercise-media/0001.webp', '/apix', '/x/api/me']) {
    await request(gw.url, { path, headers: [['X-Remote-User-Id', HA_ID]] });
  }
  assert.equal(internal.calls.length, 0);
  for (const seen of web.seen) assert.equal(seen.headers.cookie, undefined, seen.url);
});

test('concurrent requests for one HA id share one in-flight call; nothing is cached afterwards', async () => {
  const store = haSessionStore({ delayMs: 150 });
  const { web, internal, gw } = await setup({ store });
  const headers = [['X-Remote-User-Id', HA_ID]];
  const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => request(gw.url, { path: `/api/x${i}`, headers })));
  assert.ok(rs.every(r => r.status === 200));
  assert.equal(internal.calls.length, 1, 'one call for six concurrent requests');
  assert.equal(store.users.length, 1);
  assert.ok(web.seen.every(s => s.headers.cookie === 'gymsid=tok-u1'));
  // A second HA user is a separate call, and a later request asks again (no cache).
  await Promise.all([
    request(gw.url, { path: '/api/a', headers: [['X-Remote-User-Id', 'other-ha-user']] }),
    request(gw.url, { path: '/api/b', headers }),
  ]);
  assert.equal(internal.calls.length, 3);
  assert.equal(store.users.length, 2);
});

test('a client that hangs up while its session is being minted is not proxied', async () => {
  const store = haSessionStore({ delayMs: 200 });
  const { web, internal, gw } = await setup({ store });
  const req = http.request(`${gw.url}/api/me`, { headers: { 'X-Remote-User-Id': HA_ID } });
  req.on('error', () => {});
  req.end();
  await new Promise(r => setTimeout(r, 50));
  req.destroy();
  await new Promise(r => setTimeout(r, 300));
  assert.equal(internal.calls.length, 1, 'the mint was under way');
  assert.equal(web.connections(), 0, 'not even a connection opened upstream for a client that is gone');
  assert.equal(web.seen.length, 0);
  assert.equal((await request(gw.url, { path: '/api/me', headers: [['X-Remote-User-Id', HA_ID]] })).status, 200, 'and the gateway keeps serving');
});

test('a disabled profile goes on anonymously (no session cookie)', async () => {
  const store = haSessionStore({ disabled: new Set([HA_ID]) });
  const { web, gw } = await setup({ store });
  const r = await request(gw.url, { path: '/api/me', headers: [['X-Remote-User-Id', HA_ID], ['Cookie', 'gymsid=old']] });
  assert.equal(r.status, 200);
  assert.equal(web.seen[0].headers.cookie, undefined);
});

test('the display name is re-decoded from latin1 to UTF-8; the user name is the fallback', async () => {
  const { internal, gw } = await setup();
  await request(gw.url, { path: '/api/me', headers: [['X-Remote-User-Id', 'a1'], ['X-Remote-User-Name', 'zoe'], ['X-Remote-User-Display-Name', latin1('Zoë')]] });
  await request(gw.url, { path: '/api/me', headers: [['X-Remote-User-Id', 'b2'], ['X-Remote-User-Name', latin1('jürgen')]] });
  await request(gw.url, { path: '/api/me', headers: [['X-Remote-User-Id', 'c3']] });
  assert.deepEqual(internal.calls.map(c => c.body.name), ['Zoë', 'jürgen', '']);
});

test('the first, admin profile is logged once, at creation', async () => {
  const { gw } = await setup();
  // CR/LF cannot travel in a header at all; a tab, a NEL (U+0085, from UTF-8 C2 85) and U+2028 can.
  await request(gw.url, { path: '/api/me', headers: [['X-Remote-User-Id', HA_ID], ['X-Remote-User-Display-Name', latin1('Zoë\t\u0085forged\u2028line')]] });
  await request(gw.url, { path: '/api/me', headers: [['X-Remote-User-Id', HA_ID]] });
  await request(gw.url, { path: '/api/me', headers: [['X-Remote-User-Id', 'second']] });
  const lines = gw.log.lines.filter(l => l.includes('is the openGym admin'));
  assert.deepEqual(lines, ['openGym: HA user Zoë  forged line is the openGym admin (first profile on this instance)']);
});

test('internal listener down: /api/* with identity is a curated 502, static still served', async () => {
  const web = track(await startFakeNginx());
  const gw = track(await startGateway({ peer: INGRESS_PEER, socketPath: '/nonexistent/internal.sock', config: { webUrl: web.url } }));
  const r = await request(gw.url, { path: '/api/me', headers: [['X-Remote-User-Id', HA_ID]] });
  assert.equal(r.status, 502);
  assert.deepEqual(json(r), { error: 'openGym is not responding' });
  assert.equal(web.seen.length, 0);
  assert.equal((await request(gw.url, { path: '/index.html', headers: [['X-Remote-User-Id', HA_ID]] })).status, 200);
});

test('Origin rule end to end: deleted only for a write without Sec-Fetch-Site from HA\'s own host', async () => {
  const { web, gw } = await setup();
  const ha = [['Origin', 'https://ha.example.com:8123'], ['X-Forwarded-Host', 'ha.example.com:8123']];
  await request(gw.url, { method: 'PUT', path: '/api/data', headers: ha, body: '{}' });
  await request(gw.url, { method: 'PUT', path: '/api/data', headers: [...ha, ['Sec-Fetch-Site', 'same-origin']], body: '{}' });
  await request(gw.url, { method: 'GET', path: '/api/data', headers: ha });
  await request(gw.url, { method: 'POST', path: '/api/data', headers: [['Origin', 'https://evil.example'], ['X-Forwarded-Host', 'ha.example.com:8123']], body: '{}' });
  assert.deepEqual(web.seen.map(s => s.headers.origin), [undefined, 'https://ha.example.com:8123', 'https://ha.example.com:8123', 'https://evil.example']);
  assert.equal(web.seen[1].headers['sec-fetch-site'], 'same-origin', 'a present Sec-Fetch-Site is passed on untouched');
});

test('Origin rule is ingress-only: a direct write keeps its Origin', async () => {
  const { web, gw } = await setup({ peer: '192.168.1.9', directAccess: true });
  await request(gw.url, { method: 'PUT', path: '/api/data', headers: [['Origin', 'https://gym.example.com'], ['X-Forwarded-Host', 'gym.example.com']], body: '{}' });
  assert.equal(web.seen[0].headers.origin, 'https://gym.example.com');
});

const MEDIA = `/api/media/${'ab'.repeat(32)}`;

test('ingress media upload sent as POST + X-OpenGym-Method: PUT reaches upstream as that PUT, body whole', async () => {
  const { web, gw } = await setup();
  // Chunked and without a length, as the Supervisor streams it with ingress_stream.
  const body = Buffer.alloc(3 * 1024 * 1024 + 7, 0x61);
  const r = await request(gw.url, { method: 'POST', path: MEDIA, headers: [['X-OpenGym-Method', 'PUT'], ['Content-Type', 'video/mp4'], ['Transfer-Encoding', 'chunked']], body });
  assert.equal(r.status, 200);
  assert.equal(web.seen.length, 1);
  assert.equal(web.seen[0].method, 'PUT');
  assert.equal(web.seen[0].url, MEDIA);
  assert.equal(web.seen[0].headers['x-opengym-method'], undefined, 'the tunnel header never reaches upstream');
  assert.equal(web.seen[0].headers['content-type'], 'video/mp4');
  assert.ok(body.equals(web.seen[0].body), 'every byte arrives');
});

test('the upload rewrite is that one route and header value, from the ingress peer only', async () => {
  const { web, gw } = await setup();
  const cases = [
    ['POST', '/api/media/missing', 'PUT', 'POST'],          // the app's own POSTs on the same prefix
    ['POST', `${MEDIA}x`, 'PUT', 'POST'],                  // not a sha256
    ['POST', '/api/data', 'PUT', 'POST'],                  // the state sync is never re-routed
    ['POST', MEDIA, 'DELETE', 'POST'],                     // only PUT can be asked for
    ['POST', MEDIA, 'put', 'POST'],
    ['POST', MEDIA, null, 'POST'],                         // no header, no rewrite
    ['DELETE', MEDIA, 'PUT', 'DELETE'],                    // only a POST is rewritten
    ['PUT', MEDIA, null, 'PUT'],                           // a real PUT is left as it is
  ];
  for (const [method, path, ask, expected] of cases) {
    const headers = ask === null ? [] : [['X-OpenGym-Method', ask]];
    await request(gw.url, { method, path, headers, body: method === 'GET' ? null : 'x' });
    const seen = web.seen.at(-1);
    assert.equal(seen.method, expected, `${method} ${path} asking ${ask}`);
    assert.equal(seen.headers['x-opengym-method'], undefined, `${method} ${path}: header dropped`);
  }

  const direct = await setup({ peer: '192.168.1.9', directAccess: true });
  await request(direct.gw.url, { method: 'POST', path: MEDIA, headers: [['X-OpenGym-Method', 'PUT']], body: 'x' });
  assert.equal(direct.web.seen[0].method, 'POST', 'direct access is never rewritten');
  assert.equal(direct.web.seen[0].headers['x-opengym-method'], undefined);
});

const FRAMING = {
  'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff',
  'Set-Cookie': ['gymsid=new; Path=/; HttpOnly', 'gymsid=; Path=/; Max-Age=0', '__Host-gymsid=n; Path=/; Secure', 'pref=1; Path=/'],
};
const redirecting = (req, res) => { res.writeHead(302, { ...FRAMING, Location: '/?from=root' }); res.end(); };

test('ingress responses: SAMEORIGIN, frame-ancestors self, no session Set-Cookie, Location under X-Ingress-Path', async () => {
  const { gw } = await setup({ nginx: { respond: redirecting } });
  const r = await request(gw.url, { path: '/missing', headers: [['X-Ingress-Path', '/api/hassio_ingress/AbC123']] });
  assert.equal(r.status, 302);
  assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(r.headers['content-security-policy'], "frame-ancestors 'self'");
  assert.deepEqual(r.headers['set-cookie'], ['pref=1; Path=/']);
  assert.equal(r.headers.location, '/api/hassio_ingress/AbC123/?from=root');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

test('direct responses: none of the ingress rewrites', async () => {
  const { gw } = await setup({ peer: '192.168.1.9', directAccess: true, nginx: { respond: redirecting } });
  const r = await request(gw.url, { path: '/missing', headers: [['X-Ingress-Path', '/api/hassio_ingress/AbC123']] });
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['content-security-policy'], "frame-ancestors 'none'");
  assert.deepEqual(r.headers['set-cookie'], FRAMING['Set-Cookie']);
  assert.equal(r.headers.location, '/?from=root');
});

test('client address headers: X-Forwarded-For / X-Real-IP overwritten with the peer, CF-Connecting-IP dropped', async () => {
  for (const [peer, directAccess] of [[INGRESS_PEER, false], ['192.168.1.9', true]]) {
    const { web, gw } = await setup({ peer, directAccess });
    await request(gw.url, { path: '/api/login/options', headers: [['X-Forwarded-For', '1.2.3.4'], ['X-Real-IP', '5.6.7.8'], ['CF-Connecting-IP', '9.9.9.9']] });
    const h = web.seen[0].headers;
    assert.equal(h['x-forwarded-for'], peer);
    assert.equal(h['x-real-ip'], peer);
    assert.equal(h['cf-connecting-ip'], undefined);
  }
});

test('hop-by-hop request headers are not forwarded; Host and end-to-end headers are', async () => {
  const { web, gw } = await setup({ peer: '192.168.1.9', directAccess: true });
  await request(gw.url, { path: '/x', headers: [['Host', 'gym.example.com'], ['Connection', 'keep-alive, X-Secret-Hop'], ['X-Secret-Hop', '1'], ['Keep-Alive', 'timeout=5'], ['TE', 'trailers'], ['Accept', 'text/html']] });
  const h = web.seen[0].headers;
  assert.equal(h.host, 'gym.example.com');
  assert.equal(h['x-secret-hop'], undefined);
  assert.equal(h['keep-alive'], undefined);
  assert.equal(h.te, undefined);
  assert.equal(h.accept, 'text/html');
});

test('/ha/v1: Bearer required (missing / wrong -> 401), correct -> 200; health needs none', async () => {
  const store = haSessionStore();
  store.users.push({ id: 'u1', name: 'Alex', admin: true, disabled: false, ha: 'x' }, { id: 'u2', name: 'Old', admin: false, disabled: true, ha: null });
  const { gw } = await setup({ store });
  for (const headers of [[], [['Authorization', 'Bearer wrong']], [['Authorization', TOKEN]], [['Authorization', `Bearer ${TOKEN}x`]]]) {
    for (const path of ['/ha/v1/profiles', '/ha/v1/summary', '/ha/v1/nope']) {
      const r = await request(gw.url, { path, headers });
      assert.equal(r.status, 401, `${path} ${JSON.stringify(headers)}`);
      assert.deepEqual(json(r), { error: 'unauthorized' });
    }
    const w = await request(gw.url, { method: 'POST', path: '/ha/v1/profiles/u1/bodyweight', headers, body: '{"weight":80,"unit":"kg"}' });
    assert.equal(w.status, 401);
  }
  const ok = await request(gw.url, { path: '/ha/v1/profiles', headers: [['Authorization', `Bearer ${TOKEN}`]] });
  assert.equal(ok.status, 200);
  assert.deepEqual(json(ok), { profiles: [{ id: 'u1', name: 'Alex', admin: true }] }, 'disabled profiles left out');
  assert.equal((await request(gw.url, { path: '/ha/v1/nope', headers: [['Authorization', `Bearer ${TOKEN}`]] })).status, 404);
  const h = await request(gw.url, { path: '/ha/v1/health' });
  assert.equal(h.status, 200);
  assert.deepEqual(json(h), { ok: true, version: '0.1.0', opengym_version: '1.4.1' });
});

test('/ha/v1 with the internal listener down: curated 502', async () => {
  const gw = track(await startGateway({ socketPath: '/nonexistent/internal.sock' }));
  const r = await request(gw.url, { path: '/ha/v1/summary', headers: [['Authorization', `Bearer ${TOKEN}`]] });
  assert.equal(r.status, 502);
  assert.deepEqual(json(r), { error: 'openGym is not responding' });
});

test('/healthz passes the api health status and body through; api down -> 502', async () => {
  let health = [200, { ok: true, users: 2, writable: true }];
  const { gw } = await setup({ api: { 'GET /api/health': async () => health } });
  let r = await request(gw.url, { path: '/healthz' });
  assert.equal(r.status, 200);
  assert.deepEqual(json(r), { ok: true, users: 2, writable: true });
  health = [503, { ok: false, writable: false }];
  r = await request(gw.url, { path: '/healthz' });
  assert.equal(r.status, 503);
  assert.deepEqual(json(r), { ok: false, writable: false });
  const down = track(await startGateway({ config: { apiUrl: 'http://127.0.0.1:9' } }));
  r = await request(down.url, { path: '/healthz' });
  assert.equal(r.status, 502);
  assert.deepEqual(json(r), { error: 'openGym is not responding' });
});
