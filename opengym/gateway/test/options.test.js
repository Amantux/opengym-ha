import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { formatResolved, resolveOptions, resolveOptionsFile } from '../src/options.js';
import { tmpDir } from './helpers/servers.js';

test('defaults: empty options resolve to localhost with direct access off', () => {
  const { resolved, problems } = resolveOptions({});
  assert.deepEqual(problems, []);
  assert.deepEqual(resolved, {
    ORIGIN: 'http://localhost:8099', RP_ID: 'localhost', DIRECT_ACCESS: 'false',
    PASSWORD_LOGIN: '0', INVITE_ONLY: '0', ALLOW_GUEST: '0', DEFAULT_LANG: '',
    INSTALL_INTEGRATION: 'false',
  });
});

test('"" and null mean unset (the HA UI writes "" for a cleared field)', () => {
  const { resolved } = resolveOptions({ external_url: '', default_lang: '  ', password_login: null });
  assert.equal(resolved.ORIGIN, 'http://localhost:8099');
  assert.equal(resolved.DIRECT_ACCESS, 'false');
  assert.equal(resolved.DEFAULT_LANG, '');
  assert.equal(resolved.PASSWORD_LOGIN, '0');
});

test('external_url: http and https resolve to origin, host name and direct access on', () => {
  for (const [input, origin, rpId] of [
    ['https://gym.example.com', 'https://gym.example.com', 'gym.example.com'],
    ['https://gym.example.com/', 'https://gym.example.com', 'gym.example.com'],
    ['http://homeassistant.local:8099', 'http://homeassistant.local:8099', 'homeassistant.local'],
    ['  https://Gym.Example.com:8443  ', 'https://gym.example.com:8443', 'gym.example.com'],
  ]) {
    const { resolved, problems } = resolveOptions({ external_url: input });
    assert.deepEqual(problems, [], input);
    assert.equal(resolved.ORIGIN, origin, input);
    assert.equal(resolved.RP_ID, rpId, input);
    assert.equal(resolved.DIRECT_ACCESS, 'true', input);
  }
});

test('external_url: path, query, fragment, userinfo, other schemes and garbage are refused', () => {
  for (const bad of [
    'https://gym.example.com/opengym', 'https://gym.example.com/?x=1', 'https://gym.example.com/?',
    'https://gym.example.com/#top', 'https://gym.example.com#', 'https://user:pw@gym.example.com',
    'https://user@gym.example.com', 'ftp://gym.example.com', 'javascript:alert(1)', 'gym.example.com',
    'not a url', 'https://', 12345,
  ]) {
    const { resolved, problems } = resolveOptions({ external_url: bad });
    assert.equal(resolved, null, String(bad));
    assert.ok(problems.length >= 1, String(bad));
    assert.ok(problems.every(p => p.includes('external_url')), `${bad}: ${problems}`);
  }
});

test('resolved values outside the shell-safe set are refused (IPv6 brackets)', () => {
  const { resolved, problems } = resolveOptions({ external_url: 'http://[::1]:8099' });
  assert.equal(resolved, null);
  assert.match(problems.join('\n'), /outside \[A-Za-z0-9\._:\/@-\]/);
});

test('booleans: true/false only', () => {
  const ok = resolveOptions({ password_login: true, invite_only: false, allow_guest: true });
  assert.equal(ok.resolved.PASSWORD_LOGIN, '1');
  assert.equal(ok.resolved.INVITE_ONLY, '0');
  assert.equal(ok.resolved.ALLOW_GUEST, '1');
  for (const bad of ['true', 1, 'yes', {}]) {
    const r = resolveOptions({ invite_only: bad });
    assert.equal(r.resolved, null, String(bad));
    assert.match(r.problems.join(), /invite_only must be true or false/);
  }
});

test('install_integration: true/false only, unset = false', () => {
  assert.equal(resolveOptions({ install_integration: true }).resolved.INSTALL_INTEGRATION, 'true');
  assert.equal(resolveOptions({ install_integration: false }).resolved.INSTALL_INTEGRATION, 'false');
  assert.equal(resolveOptions({ install_integration: null }).resolved.INSTALL_INTEGRATION, 'false');
  assert.equal(resolveOptions({}).resolved.INSTALL_INTEGRATION, 'false');
  for (const bad of ['true', 'yes', 1, 0, '', {}]) {
    const r = resolveOptions({ install_integration: bad });
    assert.equal(r.resolved, null, String(bad));
    assert.match(r.problems.join(), /install_integration must be true or false/);
  }
});

test('default_lang: tag shape only', () => {
  for (const good of ['de', 'pt-BR', 'pt_br', 'zh-TW', 'fil']) {
    assert.equal(resolveOptions({ default_lang: good }).resolved.DEFAULT_LANG, good);
  }
  for (const bad of ['d', 'english', 'pt-', 'de;rm -rf', 'de BR', 'zh-Hant-TW', 7]) {
    const r = resolveOptions({ default_lang: bad });
    assert.equal(r.resolved, null, String(bad));
    assert.match(r.problems.join(), /default_lang/);
  }
});

test('every problem is reported together', () => {
  const { resolved, problems } = resolveOptions({
    external_url: 'ftp://x/y?z', password_login: 'yes', invite_only: 0, allow_guest: 'no', default_lang: 'nope!',
    install_integration: 'on',
  });
  assert.equal(resolved, null);
  const all = problems.join('\n');
  for (const key of ['external_url', 'password_login', 'invite_only', 'allow_guest', 'default_lang', 'install_integration']) assert.match(all, new RegExp(key));
  // external_url alone has three faults here (scheme, path, query): all of them, not the first.
  assert.equal(problems.filter(p => p.includes('external_url')).length, 3);
});

test('problem messages never carry raw control characters from the value', () => {
  const { problems } = resolveOptions({ external_url: 'http://x/\nRESOLVED_ORIGIN=evil' });
  assert.ok(problems.length);
  for (const p of problems) assert.doesNotMatch(p, /\n/);
});

test('every formatted value is in the shell-safe set, in a fixed order', () => {
  const { resolved } = resolveOptions({ external_url: 'https://gym.example.com:8443', default_lang: 'pt_BR', allow_guest: true });
  const out = formatResolved(resolved);
  const lines = out.trim().split('\n');
  assert.deepEqual(lines.map(l => l.split('=')[0]), [
    'RESOLVED_ORIGIN', 'RESOLVED_RP_ID', 'RESOLVED_DIRECT_ACCESS', 'RESOLVED_PASSWORD_LOGIN',
    'RESOLVED_INVITE_ONLY', 'RESOLVED_ALLOW_GUEST', 'RESOLVED_DEFAULT_LANG', 'RESOLVED_INSTALL_INTEGRATION',
  ]);
  for (const l of lines) assert.match(l, /^RESOLVED_[A-Z_]+=[A-Za-z0-9._:/@-]*$/);
});

test('options file: missing = defaults, unparseable = problem, not an object = problem', () => {
  const dir = tmpDir();
  assert.equal(resolveOptionsFile(path.join(dir, 'missing.json')).resolved.DIRECT_ACCESS, 'false');
  fs.writeFileSync(path.join(dir, 'bad.json'), '{nope');
  assert.match(resolveOptionsFile(path.join(dir, 'bad.json')).problems.join(), /not valid JSON/);
  fs.writeFileSync(path.join(dir, 'arr.json'), '[]');
  assert.match(resolveOptionsFile(path.join(dir, 'arr.json')).problems.join(), /JSON object/);
  fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify({ external_url: 'https://g.example', password_login: true }));
  const ok = resolveOptionsFile(path.join(dir, 'ok.json')).resolved;
  assert.equal(ok.ORIGIN, 'https://g.example');
  assert.equal(ok.PASSWORD_LOGIN, '1');
});
