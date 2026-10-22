// Contract test against the REAL patched upstream api (skipped unless REAL_API_DIR is set).
//
//   REAL_API_DIR=/app node --test test/contract.real.test.js     (inside the built add-on image)
//
// REAL_API_DIR is an upstream api directory with the add-on's patch applied and node_modules
// installed. The api is spawned with its internal socket and the real gateway is driven in
// front of it, with UPSTREAM_WEB_URL pointed straight at the api (nginx only maps /api 1:1).
// What it proves, on every upstream bump: the session format the internal listener mints is
// one upstream's own /api/me accepts, HA users map to their own profiles, upstream's CSRF check
// still runs, and the integration's write lands through upstream's real sync route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { INGRESS_PEER } from '../src/gateway.js';
import { json, request, startGateway, tmpDir, TOKEN } from './helpers/servers.js';
import { createInternalClient } from '../src/internal.js';

const REAL = process.env.REAL_API_DIR;
const latin1 = s => Buffer.from(s, 'utf8').toString('latin1');

function spawnApi(dataDir, socketPath) {
  const child = spawn(process.execPath, [path.join(REAL, 'server.js')], {
    cwd: REAL,
    env: {
      PATH: process.env.PATH, NODE_ENV: 'production', DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: '0',
      ORIGIN: 'http://localhost:8099', RP_ID: 'localhost', RP_NAME: 'openGym', FIRST_USER_ADMIN: '1', TRUST_PROXY: '1',
      PASSWORD_LOGIN: '0', INVITE_ONLY: '0', ALLOW_GUEST: '0', HA_INTERNAL_SOCKET: socketPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const port = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`api never announced a port:\n${out}`)), 20_000);
    child.stdout.on('data', () => { const m = /gym-api on :(\d+)/.exec(out); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    child.once('exit', code => { clearTimeout(t); reject(new Error(`api exited (${code}):\n${out}`)); });
  });
  return { child, port, output: () => out };
}

test('real api: ingress SSO, per-user profiles, CSRF, and the integration write', { skip: !REAL && 'REAL_API_DIR not set (the Integrate step runs this inside the built image)' }, async t => {
  const dataDir = tmpDir('gw-real-data-');
  const sockDir = tmpDir('gw-real-sock-');
  const socketPath = path.join(sockDir, 'internal.sock');
  const api = spawnApi(dataDir, socketPath);
  t.after(() => api.child.kill('SIGTERM'));
  const apiUrl = `http://127.0.0.1:${await api.port}`;
  const { effectiveRoutineId } = await import(pathToFileURL(path.join(REAL, 'queue.js')).href);
  const gw = await startGateway({
    peer: INGRESS_PEER,
    internal: createInternalClient({ socketPath }),
    effectiveRoutineId,
    config: { webUrl: apiUrl, apiUrl, dataDir, envTz: 'UTC' },
  });
  t.after(() => gw.close());

  const as = (haId, name, extra = []) => [['X-Remote-User-Id', haId], ['X-Remote-User-Display-Name', latin1(name)], ...extra];
  const auth = [['Authorization', `Bearer ${TOKEN}`]];
  let one, two;

  await t.test('first HA user: profile created on the first ingress request, /api/me 200 as that user, admin', async () => {
    const r = await request(gw.url, { path: '/api/me', headers: as('ha-user-one', 'Zoë') });
    assert.equal(r.status, 200, r.body.toString());
    one = json(r).user;
    assert.equal(one.name, 'Zoë');
    assert.equal(one.admin, true, 'FIRST_USER_ADMIN: the first profile on the instance');
    assert.ok(gw.log.lines.some(l => l.includes('HA user Zoë is the openGym admin')));
    const again = json(await request(gw.url, { path: '/api/me', headers: as('ha-user-one', 'Renamed In HA') })).user;
    assert.equal(again.id, one.id, 'same HA user, same profile');
    assert.equal(again.name, 'Zoë', 'the name is only used at creation');
  });

  await t.test('second HA user: a different profile; concurrent first requests make exactly one', async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => request(gw.url, { path: '/api/me', headers: as('ha-user-two', 'Sam') })));
    assert.ok(rs.every(r => r.status === 200));
    const ids = new Set(rs.map(r => json(r).user.id));
    assert.equal(ids.size, 1);
    two = json(rs[0]).user;
    assert.notEqual(two.id, one.id);
    assert.equal(two.admin, false);
    const profiles = json(await request(gw.url, { path: '/ha/v1/profiles', headers: auth })).profiles;
    assert.deepEqual(profiles.map(p => p.id).sort(), [one.id, two.id].sort());
  });

  await t.test('no identity -> anonymous (401); a forged client cookie never overrides the HA user', async () => {
    assert.equal((await request(gw.url, { path: '/api/me' })).status, 401);
    const r = await request(gw.url, { path: '/api/me', headers: as('ha-user-two', 'Sam', [['Cookie', 'gymsid=forged.value; __Host-gymsid=x']]) });
    assert.equal(json(r).user.id, two.id);
  });

  await t.test('writes through ingress: Origin rule passes upstream CSRF; a cross-site write is still refused', async () => {
    const state = { unit: 'kg', bodyweight: [], workouts: [], routines: [{ id: 'r1', name: 'Push A', ex: [] }], week: { 1: 'r1' }, dayPlan: {} };
    const ha = [['Origin', 'http://homeassistant.local:8123'], ['X-Forwarded-Host', 'homeassistant.local:8123'], ['Content-Type', 'application/json']];
    const cross = await request(gw.url, { method: 'PUT', path: '/api/data', headers: as('ha-user-one', 'Zoë', [...ha, ['Sec-Fetch-Site', 'cross-site']]), body: JSON.stringify({ state }) });
    assert.equal(cross.status, 403, 'upstream CSRF still decides on Sec-Fetch-Site');
    const ok = await request(gw.url, { method: 'PUT', path: '/api/data', headers: as('ha-user-one', 'Zoë', ha), body: JSON.stringify({ state, stamped: true }) });
    assert.equal(ok.status, 200, ok.body.toString());
  });

  await t.test('integration write: no-data 409 for a profile never synced; lb weigh-in lands in kg via the real PUT', async () => {
    const none = await request(gw.url, { method: 'POST', path: `/ha/v1/profiles/${two.id}/bodyweight`, headers: auth, body: '{"weight":70,"unit":"kg"}' });
    assert.equal(none.status, 409);
    const r = await request(gw.url, { method: 'POST', path: `/ha/v1/profiles/${encodeURIComponent(one.id)}/bodyweight`, headers: auth, body: JSON.stringify({ weight: 176.8, unit: 'lb', date: '2026-10-21' }) });
    assert.equal(r.status, 200, r.body.toString());
    assert.deepEqual(json(r).entry, { date: '2026-10-21', value: 80.2, unit: 'kg' });
    const data = json(await request(gw.url, { path: '/api/data', headers: as('ha-user-one', 'Zoë') }));
    assert.deepEqual(data.state.bodyweight.map(e => [e.d, e.w]), [['2026-10-21', 80.2]]);
    assert.equal(data.rev, json(r).rev);
    const unknown = await request(gw.url, { method: 'POST', path: '/ha/v1/profiles/nope/bodyweight', headers: auth, body: '{"weight":70,"unit":"kg"}' });
    assert.equal(unknown.status, 404);
  });

  await t.test('summary from the real data dir', async () => {
    const s = json(await request(gw.url, { path: '/ha/v1/summary', headers: auth }));
    const p1 = s.profiles.find(p => p.id === one.id);
    const p2 = s.profiles.find(p => p.id === two.id);
    assert.equal(p1.body_weight.value, 80.2);
    assert.equal(p1.rev > 0, true);
    assert.equal(p2.rev, 0);
    assert.equal(p2.today.rest_day, true);
  });
});
