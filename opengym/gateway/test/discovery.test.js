// Supervisor discovery against a fake Supervisor (SUPERVISOR_API) and a fake gateway /healthz
// (GATEWAY_PORT). Sleeps are injected, so the ~2 minute backoff runs instantly.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { runDiscovery } from '../src/discovery.js';
import { close, listen, tmpDir } from './helpers/servers.js';

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

const INTEGRATION_TOKEN = 'I'.repeat(43);

async function fakeSupervisor({ info = () => [200, { result: 'ok', data: { hostname: 'local-opengym' } }], discovery = () => [200, { result: 'ok', data: { uuid: 'x' } }] } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const [status, json] = req.url === '/addons/self/info' ? info(calls) : req.url === '/discovery' ? discovery(calls) : [404, {}];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  const { port } = await listen(server, 0, '127.0.0.1');
  cleanups.push(() => close(server));
  return { url: `http://127.0.0.1:${port}`, calls };
}

async function fakeGatewayHealth() {
  const server = http.createServer((req, res) => { res.writeHead(req.url === '/healthz' ? 200 : 404); res.end('{}'); });
  const { port } = await listen(server, 0, '127.0.0.1');
  cleanups.push(() => close(server));
  return port;
}

function stateDirWithToken() {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'integration_token'), INTEGRATION_TOKEN + '\n', { mode: 0o600 });
  return dir;
}

function harness(env) {
  const lines = [];
  const sleeps = [];
  return {
    lines, sleeps,
    run: () => runDiscovery({ env, log: l => lines.push(l), sleep: async ms => { sleeps.push(ms); }, baseDelayMs: 2_000, readyTimeoutMs: 50, readyPollMs: 10 }),
  };
}

test('payload shape: service opengym, Supervisor hostname, gateway port, integration token', async () => {
  const sup = await fakeSupervisor();
  const port = await fakeGatewayHealth();
  const h = harness({ SUPERVISOR_TOKEN: 'sup-tok', SUPERVISOR_API: sup.url, GATEWAY_PORT: String(port), GATEWAY_STATE_DIR: stateDirWithToken() });
  assert.deepEqual(await h.run(), { status: 'sent' });
  const post = sup.calls.find(c => c.url === '/discovery');
  assert.equal(post.method, 'POST');
  assert.equal(post.auth, 'Bearer sup-tok');
  assert.deepEqual(post.body, { service: 'opengym', config: { host: 'local-opengym', port, token: INTEGRATION_TOKEN } });
  assert.equal(sup.calls.find(c => c.url === '/addons/self/info').auth, 'Bearer sup-tok');
  assert.ok(h.lines.every(l => !l.includes(INTEGRATION_TOKEN) && !l.includes('sup-tok')), 'no secret in the log');
});

test('the default port in the payload is 8099', async () => {
  const sup = await fakeSupervisor();
  // Nothing answers on 8099 here: the readiness wait times out and the announcement still goes.
  const h = harness({ SUPERVISOR_TOKEN: 's', SUPERVISOR_API: sup.url, GATEWAY_STATE_DIR: stateDirWithToken() });
  assert.equal((await h.run()).status, 'sent');
  assert.equal(sup.calls.find(c => c.url === '/discovery').body.config.port, 8099);
  assert.ok(h.lines.some(l => l.includes('did not answer /healthz')));
});

test('retries with exponential backoff: 6 attempts, then gives up (exit path still resolves)', async () => {
  const sup = await fakeSupervisor({ discovery: () => [503, { result: 'error', message: 'secret upstream text' }] });
  const port = await fakeGatewayHealth();
  const h = harness({ SUPERVISOR_TOKEN: 's', SUPERVISOR_API: sup.url, GATEWAY_PORT: String(port), GATEWAY_STATE_DIR: stateDirWithToken() });
  assert.deepEqual(await h.run(), { status: 'failed', reason: 'discovery-refused' });
  assert.equal(sup.calls.filter(c => c.url === '/discovery').length, 6);
  assert.deepEqual(h.sleeps, [2_000, 4_000, 8_000, 16_000, 32_000], '62 s of waits plus up to 10 s per try: about two minutes');
  assert.ok(h.lines.some(l => l.includes('attempt 6/6') && l.includes('HTTP 503')));
  assert.ok(h.lines.every(l => !l.includes('secret upstream text')), 'the Supervisor\'s body is never echoed');
});

test('a transient failure is retried and then succeeds', async () => {
  const sup = await fakeSupervisor({
    info: calls => (calls.filter(c => c.url === '/addons/self/info').length < 3 ? [502, {}] : [200, { data: { hostname: 'a1b2c3d4-opengym' } }]),
  });
  const port = await fakeGatewayHealth();
  const h = harness({ SUPERVISOR_TOKEN: 's', SUPERVISOR_API: sup.url, GATEWAY_PORT: String(port), GATEWAY_STATE_DIR: stateDirWithToken() });
  assert.equal((await h.run()).status, 'sent');
  assert.equal(sup.calls.find(c => c.url === '/discovery').body.config.host, 'a1b2c3d4-opengym');
  assert.deepEqual(h.sleeps, [2_000, 4_000]);
});

test('no SUPERVISOR_TOKEN: logged skip, nothing contacted', async () => {
  const sup = await fakeSupervisor();
  const h = harness({ SUPERVISOR_API: sup.url, GATEWAY_STATE_DIR: stateDirWithToken() });
  assert.deepEqual(await h.run(), { status: 'skipped', reason: 'no-supervisor' });
  assert.equal(sup.calls.length, 0);
  assert.deepEqual(h.lines, ['openGym discovery: not running under the Supervisor, discovery skipped']);
});

test('hostname lookup failing or empty: skipped, the container id is never announced', async () => {
  for (const info of [() => [500, {}], () => [200, { data: {} }], () => [200, { data: { hostname: '' } }], () => [200, { data: { hostname: 'bad host!' } }]]) {
    const sup = await fakeSupervisor({ info });
    const port = await fakeGatewayHealth();
    const h = harness({ SUPERVISOR_TOKEN: 's', SUPERVISOR_API: sup.url, GATEWAY_PORT: String(port), GATEWAY_STATE_DIR: stateDirWithToken(), HOSTNAME: 'deadbeefcafe' });
    assert.deepEqual(await h.run(), { status: 'skipped', reason: 'no-hostname' });
    assert.equal(sup.calls.filter(c => c.url === '/discovery').length, 0, 'nothing announced');
    assert.ok(h.lines.some(l => l.includes('discovery skipped')));
  }
});

test('no integration token on disk: skipped (an empty token would be useless to HA)', async () => {
  const sup = await fakeSupervisor();
  const port = await fakeGatewayHealth();
  const h = harness({ SUPERVISOR_TOKEN: 's', SUPERVISOR_API: sup.url, GATEWAY_PORT: String(port), GATEWAY_STATE_DIR: tmpDir() });
  assert.deepEqual(await h.run(), { status: 'skipped', reason: 'no-token' });
  assert.equal(sup.calls.length, 0);
});
