import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bearerMatches, ensureIntegrationToken } from '../src/token.js';
import { quietLog, tmpDir } from './helpers/servers.js';

test('integration token: created once with mode 0600, then reused unchanged', () => {
  const dir = path.join(tmpDir(), 'gateway'); // the state dir does not exist yet
  const first = ensureIntegrationToken(dir);
  const file = path.join(dir, 'integration_token');
  const st1 = fs.statSync(file);
  assert.equal(st1.mode & 0o777, 0o600);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  const second = ensureIntegrationToken(dir);
  const st2 = fs.statSync(file);
  assert.equal(second, first);
  assert.equal(st2.ino, st1.ino, 'the file was not rewritten');
  assert.equal(st2.mtimeMs, st1.mtimeMs);
});

test('integration token: an empty or junk file is replaced, never used as the token', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'integration_token');
  for (const junk of ['', '\n', 'short', 'has spaces in it but is long enough to pass a length check']) {
    fs.writeFileSync(file, junk, { mode: 0o644 });
    const log = quietLog();
    const token = ensureIntegrationToken(dir, log);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), token);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(log.lines.length === 1 && !log.lines[0].includes(token), 'warned, without the token');
  }
});

test('bearer: missing or wrong -> false, exact -> true', () => {
  const tok = 'A'.repeat(43);
  assert.equal(bearerMatches(undefined, tok), false);
  assert.equal(bearerMatches('', tok), false);
  assert.equal(bearerMatches(tok, tok), false, 'no scheme');
  assert.equal(bearerMatches(`Basic ${tok}`, tok), false);
  assert.equal(bearerMatches(`Bearer ${tok}x`, tok), false);
  assert.equal(bearerMatches(`Bearer ${tok.slice(1)}`, tok), false);
  assert.equal(bearerMatches('Bearer ', tok), false);
  assert.equal(bearerMatches(`Bearer ${tok}`, tok), true);
  assert.equal(bearerMatches(`bearer ${tok}`, tok), true);
  // An empty expected token must never match anything, including an empty Bearer.
  assert.equal(bearerMatches('Bearer ', ''), false);
  assert.equal(bearerMatches('Bearer x', ''), false);
});

test('bearer: compared in constant time (timingSafeEqual on equal-length digests)', () => {
  const spy = mock.method(crypto, 'timingSafeEqual');
  try {
    const tok = 'B'.repeat(43);
    bearerMatches(`Bearer ${tok}`, tok);
    bearerMatches('Bearer nope', tok);
    bearerMatches(undefined, tok);
    assert.equal(spy.mock.callCount(), 3, 'every check goes through timingSafeEqual, wrong ones included');
    for (const call of spy.mock.calls) assert.equal(call.arguments[0].length, call.arguments[1].length);
  } finally {
    spy.mock.restore();
  }
});
