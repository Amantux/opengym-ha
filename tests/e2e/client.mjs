// The e2e assertion client. tests/e2e/run.sh runs it inside a node:22-alpine container at
// 172.30.32.3: on the hassio-like network, but NOT the ingress peer. Everything it asks of the
// add-on goes either through the fake ingress at 172.30.32.2 (as an HA user) or straight to
// the add-on's port 8099 (as any other container on the network would).
//
//   node client.mjs wait                    poll /healthz until the add-on answers (≤ 90 s)
//   node client.mjs default                 first boot, default options (direct access off)
//   node client.mjs restart                 after a restart: same profiles, token and data
//   node client.mjs external-url            restarted with external_url set
//
// Inputs (env): TOKEN (the integration token run.sh read from /data/gateway), EXPECT_VERSION,
// and for the later phases EXPECT_A / EXPECT_B (profile ids the default phase printed).
// Output: one "ok - " / "not ok - " line per assertion; exit 1 if any failed.
// Zero dependencies, node:http only, so every header sent is exactly the one written here.
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { syntheticMp4 } from './mp4.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADDON_IP = '172.30.33.10';
const ADDON = `http://${ADDON_IP}:8099`;
const INGRESS = 'http://172.30.32.2';
// The two HA users the fake ingress maps (fixtures/fake-ingress.conf).
const A = { prefix: '/api/hassio_ingress/abc', haId: '6a1f0c9d2b4e4f8a9c3d5e7f1a2b3c4d', name: 'Alex Example' };
const B = { prefix: '/api/hassio_ingress/xyz', haId: '9b8e7d6c5a4f4e3d8c2b1a0f9e8d7c6b', name: 'Zoë Ørsted' };
// Contract §6 / §7 strings, verbatim.
const DIRECT_OFF = "Direct access is turned off. Open openGym from the Home Assistant sidebar, or set the add-on's external_url option.";
const NO_DATA = 'This profile has no data yet. Log something in openGym as that person (a workout, a weigh-in or any setting), then try again.';

const TOKEN = process.env.TOKEN || '';
let failures = 0;
let passes = 0;

function check(name, cond, detail) {
  if (cond) { passes += 1; console.log(`ok - ${name}`); return true; }
  failures += 1;
  console.log(`not ok - ${name}${detail === undefined ? '' : `\n    got: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  return false;
}

/** One HTTP request. `headers` is a list of [name, value] pairs, sent exactly as given. */
function request(method, url, { headers = [], body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    // Array-form headers get no defaults from node:http, not even Host, and Node's server
    // refuses a request without one (400), so it is added here unless a test sets its own.
    const flat = headers.flat();
    if (!headers.some(([k]) => k.toLowerCase() === 'host')) flat.unshift('Host', u.host);
    if (payload) flat.push('Content-Type', 'application/json', 'Content-Length', String(payload.length));
    const req = http.request({ method, host: u.hostname, port: u.port || 80, path: u.pathname + u.search, headers: flat, timeout: 15_000, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout: ${method} ${url}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * A request with a binary body, in 1 MiB writes. `chunked` sends no length, the way the
 * Supervisor streams a POST to an add-on with ingress_stream; otherwise Content-Length is set,
 * the way a browser sends a Blob.
 */
function sendBody(method, url, buf, { headers = [], chunked = false, contentType = 'video/mp4' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const flat = ['Host', u.host, 'Content-Type', contentType, ...headers.flat()];
    flat.push(...(chunked ? ['Transfer-Encoding', 'chunked'] : ['Content-Length', String(buf.length)]));
    const req = http.request({ method, host: u.hostname, port: u.port || 80, path: u.pathname + u.search, headers: flat, timeout: 60_000, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout: ${method} ${url}`)));
    // A proxy refusing a big body may answer and close before reading it all.
    req.on('error', err => (err.code === 'EPIPE' || err.code === 'ECONNRESET' ? null : reject(err)));
    for (let i = 0; i < buf.length; i += 1 << 20) req.write(buf.subarray(i, i + (1 << 20)));
    req.end();
  });
}

/** GET a body as raw bytes. */
function getBytes(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ method: 'GET', host: u.hostname, port: u.port || 80, path: u.pathname, headers: ['Host', u.host], timeout: 60_000, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout: GET ${url}`)));
    req.on('error', reject);
    req.end();
  });
}

// Every response that came back through the fake ingress, for the framing/cookie sweep.
const ingressResponses = [];
async function viaIngress(user, method, p, opts) {
  const res = await request(method, INGRESS + user.prefix + p, opts);
  ingressResponses.push({ what: `${method} ${user.prefix}${p}`, res });
  return res;
}
const bearer = t => [['Authorization', `Bearer ${t}`]];
const integration = (method, p, opts = {}) => request(method, ADDON + p, { ...opts, headers: [...bearer(TOKEN), ...(opts.headers || [])] });

/** A TCP connect to host:port; resolves 'open' or the error code. */
function tcpProbe(host, port) {
  return new Promise(resolve => {
    const s = net.connect({ host, port, timeout: 3_000 });
    s.once('connect', () => { s.destroy(); resolve('open'); });
    s.once('timeout', () => { s.destroy(); resolve('timeout'); });
    s.once('error', e => resolve(e.code || 'error'));
  });
}

function sweepIngressFraming() {
  // Contract §6 step 4: every ingress response that carries a framing header allows HA's own
  // page, and no ingress response plants an openGym session cookie on HA's origin.
  const bad = [];
  for (const { what, res } of ingressResponses) {
    const xfo = res.headers['x-frame-options'];
    if (xfo !== undefined && String(xfo).toUpperCase() !== 'SAMEORIGIN') bad.push(`${what}: X-Frame-Options ${xfo}`);
    const csp = [].concat(res.headers['content-security-policy'] || []).join(' ');
    if (/frame-ancestors\s+'none'/i.test(csp)) bad.push(`${what}: CSP ${csp}`);
    const cookies = [].concat(res.headers['set-cookie'] || []);
    if (cookies.some(c => /^\s*(__Host-)?gymsid=/i.test(c))) bad.push(`${what}: Set-Cookie ${cookies.join(' | ')}`);
  }
  check(`ingress: none of ${ingressResponses.length} responses says DENY / frame-ancestors 'none' or sets a gymsid cookie`, bad.length === 0, bad);
}

async function phaseWait() {
  const deadline = Date.now() + 90_000;
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const r = await request('GET', `${ADDON}/healthz`);
      if (r.status === 200) { check(`/healthz answers 200 ${r.text}`, true); return; }
      last = `${r.status} ${r.text}`;
    } catch (e) { last = e.code || e.message; }
    await new Promise(r => setTimeout(r, 500));
  }
  failures += 1;
  console.log(`not ok - the add-on never answered /healthz with 200 within 90 s (last: ${last})`);
}

async function phaseDefault() {
  // --- health and the integration's unauthenticated endpoint -------------------------------
  const hz = await request('GET', `${ADDON}/healthz`);
  check('/healthz from a non-ingress peer: 200 with upstream\'s {ok, writable}', hz.status === 200 && hz.json?.ok === true && hz.json?.writable === true, hz.text);
  const h = await request('GET', `${ADDON}/ha/v1/health`);
  check('/ha/v1/health: no token needed, add-on and openGym versions', h.status === 200 && h.json?.ok === true
    && h.json?.version === process.env.EXPECT_VERSION && h.json?.opengym_version === '1.4.1', h.text);

  // --- the internal ports are not on the network ----------------------------------------------
  check('api port 3000 is not reachable from the network (bound to 127.0.0.1)', (await tcpProbe(ADDON_IP, 3000)) !== 'open');
  check('nginx port 8080 is not reachable from the network (bound to 127.0.0.1)', (await tcpProbe(ADDON_IP, 8080)) !== 'open');

  // --- ingress: the app shell, framed for HA ---------------------------------------------------
  const index = await viaIngress(A, 'GET', '/');
  check('ingress GET /: 200 html', index.status === 200 && /text\/html/.test(index.headers['content-type'] || '') && /<title>openGym<\/title>/.test(index.text), `${index.status} ${index.headers['content-type']}`);
  check('ingress GET /: X-Frame-Options SAMEORIGIN', index.headers['x-frame-options'] === 'SAMEORIGIN', index.headers['x-frame-options']);
  check("ingress GET /: CSP frame-ancestors 'self'", /frame-ancestors 'self'/.test(index.headers['content-security-policy'] || ''), index.headers['content-security-policy']);
  // No add-on cap on videos: big uploads stream through ingress (checked below).
  const config = await viaIngress(A, 'GET', '/api/config');
  check('ingress GET /api/config: media.videoMB is upstream\'s 40', config.status === 200 && config.json?.media?.videoMB === 40, `${config.status} ${config.text}`);
  const asset = await viaIngress(A, 'GET', '/icon-512.png');
  check('ingress static asset: 200 image, SAMEORIGIN', asset.status === 200 && /image\/png/.test(asset.headers['content-type'] || '') && asset.headers['x-frame-options'] === 'SAMEORIGIN', `${asset.status} ${asset.headers['content-type']} ${asset.headers['x-frame-options']}`);

  // --- ingress sign-in: first HA user ----------------------------------------------------------
  const meA = await viaIngress(A, 'GET', '/api/me');
  check('ingress /api/me as HA user A: 200, the HA display name, a profile id', meA.status === 200 && meA.json?.user?.name === A.name && typeof meA.json?.user?.id === 'string' && meA.json.user.id.length > 0, meA.text);
  check('HA user A (first to open openGym) is the openGym admin', meA.json?.user?.admin === true, meA.text);
  const aId = meA.json?.user?.id;
  const meA2 = await viaIngress(A, 'GET', '/api/me');
  check('a second request as HA user A finds the same profile (no duplicate)', meA2.status === 200 && meA2.json?.user?.id === aId, meA2.text);

  // --- second HA user -----------------------------------------------------------------------------
  const meB = await viaIngress(B, 'GET', '/api/me');
  const bId = meB.json?.user?.id;
  check('ingress /api/me as HA user B: 200, a different profile', meB.status === 200 && typeof bId === 'string' && bId !== aId, meB.text);
  check('HA user B\'s non-ASCII display name arrives intact (UTF-8 header bytes)', meB.json?.user?.name === B.name, meB.json?.user?.name);
  check('HA user B is not admin', meB.json?.user?.admin === false, meB.text);

  // --- the client cannot choose who it is, even through ingress ------------------------------
  const forged = await viaIngress(A, 'GET', '/api/me', { headers: [
    ['X-Remote-User-Id', B.haId], ['X-Remote-User-Name', 'zoe'], ['Cookie', 'gymsid=forged.value; other=1'], ['Authorization', 'Bearer forged.token'],
  ] });
  check('ingress as A with a forged B identity, cookie and Bearer: still A', forged.status === 200 && forged.json?.user?.id === aId, forged.text);

  // --- direct access is off: any other peer gets the 403, forged identity or not ---------------
  const direct = await request('GET', `${ADDON}/`, { headers: [['X-Remote-User-Id', A.haId], ['X-Remote-User-Name', 'alex']] });
  check('direct GET / from 172.30.32.3 with a forged X-Remote-User-Id: 403 direct-access message', direct.status === 403 && direct.json?.error === DIRECT_OFF, `${direct.status} ${direct.text}`);
  const directMe = await request('GET', `${ADDON}/api/me`, { headers: [['X-Remote-User-Id', A.haId], ['X-Forwarded-For', '172.30.32.2']] });
  check('direct GET /api/me with forged identity and X-Forwarded-For 172.30.32.2: 403', directMe.status === 403 && directMe.json?.error === DIRECT_OFF, `${directMe.status} ${directMe.text}`);

  // --- integration API: auth -----------------------------------------------------------------------
  const noTok = await request('GET', `${ADDON}/ha/v1/summary`);
  check('/ha/v1/summary without a token: 401 unauthorized', noTok.status === 401 && noTok.json?.error === 'unauthorized', `${noTok.status} ${noTok.text}`);
  const badTok = await request('GET', `${ADDON}/ha/v1/summary`, { headers: bearer(`${TOKEN}x`) });
  check('/ha/v1/summary with a wrong token: 401', badTok.status === 401, `${badTok.status}`);
  const sum0 = await integration('GET', '/ha/v1/summary');
  const ids0 = (sum0.json?.profiles || []).map(p => p.id).sort();
  check('/ha/v1/summary with the integration token: 200 listing both profiles', sum0.status === 200 && ids0.length === 2 && ids0.includes(aId) && ids0.includes(bId), sum0.text);
  const pA0 = sum0.json?.profiles?.find(p => p.id === aId);
  check('summary for a profile with no state yet: kg, no weight, rest day, rev 0', pA0?.unit === 'kg' && pA0?.body_weight === null && pA0?.rev === 0 && pA0?.today?.rest_day === true && pA0?.workouts_7d === 0, pA0);
  const profiles = await integration('GET', '/ha/v1/profiles');
  const pmap = Object.fromEntries((profiles.json?.profiles || []).map(p => [p.id, p]));
  check('/ha/v1/profiles: A (admin) and B (not admin) with their names', profiles.status === 200 && pmap[aId]?.admin === true && pmap[aId]?.name === A.name && pmap[bId]?.admin === false && pmap[bId]?.name === B.name, profiles.text);

  // --- integration write before the profile has any data: the no-data 409 ---------------------
  const weighIn = { weight: 176.8, unit: 'lb', date: '2026-10-21' };
  const early = await integration('POST', `/ha/v1/profiles/${encodeURIComponent(aId)}/bodyweight`, { body: weighIn });
  check('body-weight write before the profile ever synced: 409 no-data', early.status === 409 && early.json?.error === NO_DATA, `${early.status} ${early.text}`);
  const unknown = await integration('POST', '/ha/v1/profiles/nobody/bodyweight', { body: weighIn });
  check('body-weight write for an unknown profile: 404 unknown profile', unknown.status === 404 && unknown.json?.error === 'unknown profile', `${unknown.status} ${unknown.text}`);
  const invalid = await integration('POST', `/ha/v1/profiles/${encodeURIComponent(aId)}/bodyweight`, { body: { weight: 900, unit: 'kg' } });
  check('body-weight write over 700 kg: 400', invalid.status === 400, `${invalid.status} ${invalid.text}`);

  // --- the app's first sync through ingress, as a browser would make it ------------------------
  const push = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'first-push.json'), 'utf8'));
  delete push._comment;
  const crossSite = await viaIngress(A, 'PUT', '/api/data', { body: push, headers: [['Origin', 'http://evil.example'], ['Sec-Fetch-Site', 'cross-site']] });
  check('ingress PUT /api/data marked cross-site: refused by upstream CSRF (403)', crossSite.status === 403, `${crossSite.status} ${crossSite.text}`);
  // Old-WebKit shape: an Origin of HA's own host and no Sec-Fetch-Site (gateway rule §6.3).
  const put = await viaIngress(A, 'PUT', '/api/data', { body: push, headers: [['Origin', INGRESS]] });
  check('ingress PUT /api/data from HA\'s own origin: 200 (first sync)', put.status === 200 && put.json?.ok === true, `${put.status} ${put.text}`);
  const pulled = await viaIngress(A, 'GET', '/api/data');
  check('ingress GET /api/data: the pushed workout is there', pulled.status === 200 && pulled.json?.state?.workouts?.[0]?.id === 'w1', pulled.text.slice(0, 300));

  // --- integration write now lands ------------------------------------------------------------------
  const wrote = await integration('POST', `/ha/v1/profiles/${encodeURIComponent(aId)}/bodyweight`, { body: weighIn });
  check('body-weight write (176.8 lb into a kg profile): 200, stored as 80.2 kg', wrote.status === 200 && wrote.json?.profile_id === aId
    && wrote.json?.entry?.date === '2026-10-21' && wrote.json?.entry?.value === 80.2 && wrote.json?.entry?.unit === 'kg', `${wrote.status} ${wrote.text}`);
  const after = await viaIngress(A, 'GET', '/api/data');
  const bw = after.json?.state?.bodyweight || [];
  check('ingress GET /api/data shows the weigh-in {d, w: 80.2, t}', bw.length === 1 && bw[0].d === '2026-10-21' && bw[0].w === 80.2 && Number.isFinite(bw[0].t), bw);
  check('the write\'s reported rev is the stored rev', wrote.json?.rev === after.json?.rev, `write ${wrote.json?.rev} stored ${after.json?.rev}`);
  check('the workout from the first sync survived the integration write', after.json?.state?.workouts?.[0]?.id === 'w1', after.json?.state?.workouts);
  const sum1 = await integration('GET', '/ha/v1/summary');
  const pA1 = sum1.json?.profiles?.find(p => p.id === aId);
  check('/ha/v1/summary reports the weigh-in', sum1.status === 200 && pA1?.body_weight?.value === 80.2 && pA1?.body_weight?.unit === 'kg' && pA1?.body_weight?.date === '2026-10-21', pA1?.body_weight);
  check('/ha/v1/summary reports the last workout and the rev', pA1?.last_workout?.id === 'w1' && pA1?.last_workout?.routine_name === 'Push A' && pA1?.last_workout?.duration_min === 52 && pA1?.rev === after.json?.rev, pA1);
  const pB1 = sum1.json?.profiles?.find(p => p.id === bId);
  check('profile B is untouched', pB1?.body_weight === null && pB1?.rev === 0, pB1);

  // --- a 30 MiB video from the sidebar ------------------------------------------------------------
  // The fake ingress refuses a non-POST body over 16 MiB, as the Supervisor's ingress proxy does
  // (it reads such bodies whole, capped at 16 MiB) and passes a POST through streamed, as the
  // Supervisor does for an add-on with ingress_stream. web/ha-ingress.js turns the app's PUT
  // into that POST; the gateway turns it back.
  const video = syntheticMp4(30 * 1024 * 1024);
  const hash = crypto.createHash('sha256').update(video).digest('hex');
  const mediaPath = `/api/media/${hash}`;
  const plainPut = await sendBody('PUT', INGRESS + A.prefix + mediaPath, video, { headers: [['Sec-Fetch-Site', 'same-origin']] });
  check('a plain 30 MiB PUT through ingress is refused by the (emulated) Supervisor limit: 413', plainPut.status === 413, `${plainPut.status} ${plainPut.text.slice(0, 200)}`);
  const tunnelled = await sendBody('POST', INGRESS + A.prefix + mediaPath, video, { chunked: true, headers: [['Sec-Fetch-Site', 'same-origin'], ['X-OpenGym-Method', 'PUT']] });
  check('the same 30 MiB video as a streamed POST + X-OpenGym-Method: PUT: 201 from openGym', tunnelled.status === 201 && tunnelled.json?.ok === true && tunnelled.json?.hash === hash
    && tunnelled.json?.mime === 'video/mp4' && tunnelled.json?.size === video.length, `${tunnelled.status} ${tunnelled.text.slice(0, 200)}`);
  const back = await getBytes(INGRESS + A.prefix + mediaPath);
  check('the uploaded video plays back through ingress byte for byte', back.status === 200 && back.body.length === video.length
    && crypto.createHash('sha256').update(back.body).digest('hex') === hash, `${back.status} ${back.body.length}`);
  const asB = await getBytes(INGRESS + B.prefix + mediaPath);
  check('another HA user cannot fetch it (media is per profile)', asB.status === 404, `${asB.status}`);

  sweepIngressFraming();
  // For run.sh: the profile ids the later phases must find again.
  console.log(`E2E_IDS ${aId || ''} ${bId || ''}`);
}

async function phaseRestart() {
  const { EXPECT_A, EXPECT_B } = process.env;
  const meA = await viaIngress(A, 'GET', '/api/me');
  const meB = await viaIngress(B, 'GET', '/api/me');
  check('after restart: HA user A signs in to the same profile', meA.status === 200 && meA.json?.user?.id === EXPECT_A, meA.text);
  check('after restart: HA user B signs in to the same profile', meB.status === 200 && meB.json?.user?.id === EXPECT_B, meB.text);
  const profiles = await integration('GET', '/ha/v1/profiles');
  const ids = (profiles.json?.profiles || []).map(p => p.id).sort();
  check('after restart: the integration token from before still works and lists the same two profiles', profiles.status === 200
    && ids.length === 2 && ids.includes(EXPECT_A) && ids.includes(EXPECT_B), `${profiles.status} ${profiles.text}`);
  const sum = await integration('GET', '/ha/v1/summary');
  const pA = sum.json?.profiles?.find(p => p.id === EXPECT_A);
  check('after restart: the weigh-in is still there', pA?.body_weight?.value === 80.2, pA);
  const direct = await request('GET', `${ADDON}/`);
  check('after restart with default options: direct access still 403', direct.status === 403 && direct.json?.error === DIRECT_OFF, `${direct.status}`);
  sweepIngressFraming();
}

async function phaseExternalUrl() {
  const { EXPECT_A } = process.env;
  const forgedIdentity = [['X-Remote-User-Id', A.haId], ['X-Remote-User-Name', 'alex'], ['X-Remote-User-Display-Name', A.name]];
  const page = await request('GET', `${ADDON}/`, { headers: forgedIdentity });
  check('external_url set: direct GET / passes through (200 html)', page.status === 200 && /text\/html/.test(page.headers['content-type'] || ''), `${page.status} ${page.text.slice(0, 200)}`);
  check('external_url set: direct responses keep upstream\'s X-Frame-Options DENY', page.headers['x-frame-options'] === 'DENY', page.headers['x-frame-options']);
  check("external_url set: direct responses keep frame-ancestors 'none'", /frame-ancestors 'none'/.test(page.headers['content-security-policy'] || ''), page.headers['content-security-policy']);
  const me = await request('GET', `${ADDON}/api/me`, { headers: forgedIdentity });
  check('external_url set: direct /api/me with forged X-Remote-User-* is anonymous (401)', me.status === 401, `${me.status} ${me.text}`);
  const meXff = await request('GET', `${ADDON}/api/me`, { headers: [...forgedIdentity, ['X-Forwarded-For', '172.30.32.2'], ['X-Real-IP', '172.30.32.2']] });
  check('external_url set: forged identity plus X-Forwarded-For 172.30.32.2 is still anonymous', meXff.status === 401, `${meXff.status}`);
  const ingressMe = await viaIngress(A, 'GET', '/api/me');
  check('external_url set (https ORIGIN): ingress still signs HA user A in', ingressMe.status === 200 && ingressMe.json?.user?.id === EXPECT_A, ingressMe.text);
  const ingressPage = await viaIngress(A, 'GET', '/');
  check('external_url set: ingress responses still SAMEORIGIN', ingressPage.headers['x-frame-options'] === 'SAMEORIGIN', ingressPage.headers['x-frame-options']);
  const h = await integration('GET', '/ha/v1/profiles');
  check('external_url set: the integration API still works', h.status === 200 && (h.json?.profiles || []).length === 2, `${h.status}`);
  // The upload tunnel is for the ingress peer only: on direct access the POST stays a POST,
  // which openGym has no route for.
  const directTunnel = await sendBody('POST', `${ADDON}/api/media/${'ab'.repeat(32)}`, Buffer.from('x'), { headers: [['X-OpenGym-Method', 'PUT']] });
  check('external_url set: a direct POST + X-OpenGym-Method: PUT is not turned into a PUT (404)', directTunnel.status === 404, `${directTunnel.status} ${directTunnel.text}`);
  sweepIngressFraming();
}

const phases = { wait: phaseWait, default: phaseDefault, restart: phaseRestart, 'external-url': phaseExternalUrl };
const phase = phases[process.argv[2]];
if (!phase) {
  console.error(`usage: node client.mjs ${Object.keys(phases).join('|')}`);
  process.exit(2);
}
try {
  await phase();
} catch (e) {
  failures += 1;
  console.log(`not ok - phase ${process.argv[2]} crashed: ${e.stack || e}`);
}
console.log(`# ${process.argv[2]}: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
