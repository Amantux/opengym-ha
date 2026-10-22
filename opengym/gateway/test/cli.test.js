import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/servers.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const run = (args, env) => spawnSync(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 20_000 });

test('cli resolve prints RESOLVED_ lines and exits 0', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'options.json');
  fs.writeFileSync(file, JSON.stringify({ external_url: 'https://gym.example.com', invite_only: true, default_lang: 'de' }));
  const r = run(['resolve'], { OPENGYM_OPTIONS_FILE: file });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, [
    'RESOLVED_ORIGIN=https://gym.example.com', 'RESOLVED_RP_ID=gym.example.com', 'RESOLVED_DIRECT_ACCESS=true',
    'RESOLVED_PASSWORD_LOGIN=0', 'RESOLVED_INVITE_ONLY=1', 'RESOLVED_ALLOW_GUEST=0', 'RESOLVED_DEFAULT_LANG=de', '',
  ].join('\n'));
});

test('cli resolve: invalid options -> every problem on stderr, nothing on stdout, exit 1', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'options.json');
  fs.writeFileSync(file, JSON.stringify({ external_url: 'https://x.example/path', allow_guest: 'yes' }));
  const r = run(['resolve'], { OPENGYM_OPTIONS_FILE: file });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /external_url/);
  assert.match(r.stderr, /allow_guest/);
});

test('cli discovery without SUPERVISOR_TOKEN logs the skip and exits 0', () => {
  const r = run(['discovery'], {});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /not running under the Supervisor, discovery skipped/);
});

test('cli with an unknown command exits 2', () => {
  assert.equal(run(['frobnicate'], {}).status, 2);
});
