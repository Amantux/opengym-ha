// The real entry point, spawned with a temp data dir: token file, listening, timeouts, and a
// loud failure on invalid options.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpServer } from '../src/gateway.js';
import { request, tmpDir } from './helpers/servers.js';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
const UPSTREAM_API_DIR = process.env.UPSTREAM_API_DIR || '/app';

test('server timeouts are the contract\'s', () => {
  const s = createHttpServer(() => {});
  assert.equal(s.requestTimeout, 30 * 60 * 1000);
  assert.equal(s.headersTimeout, 60 * 1000);
  assert.equal(s.keepAliveTimeout, 65 * 1000);
});

function startServer(env) {
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const port = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 10_000);
    child.stdout.on('data', () => {
      const m = /listening on :(\d+)/.exec(out);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    child.once('exit', code => { clearTimeout(t); reject(new Error(`exited ${code}:\n${out}`)); });
  });
  return { child, port, output: () => out };
}

test('server.js creates the integration token once (0600), serves /ha/v1/health, and stops cleanly on SIGTERM', async () => {
  const root = tmpDir();
  const stateDir = path.join(root, 'gateway');
  const env = {
    GATEWAY_PORT: '0', GATEWAY_STATE_DIR: stateDir, OPENGYM_OPTIONS_FILE: path.join(root, 'options.json'),
    OPENGYM_DATA_DIR: path.join(root, 'opengym'), UPSTREAM_API_DIR, OPENGYM_HA_VERSION: '0.1.0', OPENGYM_VERSION: '1.4.1',
    HA_INTERNAL_SOCKET: path.join(root, 'none.sock'),
  };
  const tokens = [];
  for (let round = 0; round < 2; round++) {
    const s = startServer(env);
    const port = await s.port;
    const file = path.join(stateDir, 'integration_token');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    tokens.push(fs.readFileSync(file, 'utf8').trim());
    const r = await request(`http://127.0.0.1:${port}`, { path: '/ha/v1/health' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { ok: true, version: '0.1.0', opengym_version: '1.4.1' });
    // Direct access is off by default: a LAN request is refused.
    assert.equal((await request(`http://127.0.0.1:${port}`, { path: '/' })).status, 403);
    assert.ok(!s.output().includes(tokens[round]), 'the token is never logged');
    const exited = new Promise(resolve => s.child.once('exit', (code, signal) => resolve({ code, signal })));
    s.child.kill('SIGTERM');
    assert.deepEqual(await exited, { code: 0, signal: null });
  }
  assert.equal(tokens[0], tokens[1], 'reused across restarts');
});

test('server.js refuses to start on invalid options, naming every problem', () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'options.json'), JSON.stringify({ external_url: 'ftp://x', default_lang: '!!' }));
  const r = spawnSync(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, GATEWAY_PORT: '0', GATEWAY_STATE_DIR: path.join(root, 'g'), OPENGYM_OPTIONS_FILE: path.join(root, 'options.json'), UPSTREAM_API_DIR },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /external_url/);
  assert.match(r.stderr, /default_lang/);
  assert.equal(fs.existsSync(path.join(root, 'g', 'integration_token')), false, 'nothing created before the options are valid');
});
