// Unit tests of the ingress rewrite rules; gateway.test.js drives the same rules end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSessionCookie, rewriteIngressResponse, shouldDropOrigin, stripSessionCookies, utf8FromHeader } from '../src/ingress.js';

test('stripSessionCookies removes every gymsid / __Host-gymsid pair and keeps the rest', () => {
  assert.equal(stripSessionCookies(undefined), undefined);
  assert.equal(stripSessionCookies('gymsid=a'), undefined);
  assert.equal(stripSessionCookies('a=1; gymsid=x; b=2; __Host-gymsid=y; gymsid=z'), 'a=1; b=2');
  assert.equal(stripSessionCookies(' gymsid = spaced ;c=3'), 'c=3');
  assert.equal(stripSessionCookies('gymsidx=1; xgymsid=2'), 'gymsidx=1; xgymsid=2', 'only exact names');
  assert.equal(addSessionCookie(undefined, 'T'), 'gymsid=T');
  assert.equal(addSessionCookie('a=1', 'T'), 'a=1; gymsid=T');
});

test('utf8FromHeader: UTF-8 bytes read as latin1 by node come back as the real name', () => {
  const asNodeSeesIt = Buffer.from('Zoë Ångström 李', 'utf8').toString('latin1');
  assert.notEqual(asNodeSeesIt, 'Zoë Ångström 李');
  assert.equal(utf8FromHeader(asNodeSeesIt), 'Zoë Ångström 李');
  assert.equal(utf8FromHeader('Alex'), 'Alex');
  assert.equal(utf8FromHeader(undefined), '');
});

test('Origin is dropped only for a write with no Sec-Fetch-Site whose Origin host is X-Forwarded-Host', () => {
  const base = { origin: 'https://ha.example.com:8123', 'x-forwarded-host': 'ha.example.com:8123' };
  assert.equal(shouldDropOrigin('POST', base), true);
  assert.equal(shouldDropOrigin('put', base), true);
  assert.equal(shouldDropOrigin('DELETE', { ...base, 'x-forwarded-host': 'HA.example.com:8123' }), true);
  // Untouched otherwise.
  for (const m of ['GET', 'HEAD', 'OPTIONS']) assert.equal(shouldDropOrigin(m, base), false, m);
  assert.equal(shouldDropOrigin('POST', { ...base, 'sec-fetch-site': 'same-origin' }), false);
  assert.equal(shouldDropOrigin('POST', { ...base, 'sec-fetch-site': 'cross-site' }), false);
  assert.equal(shouldDropOrigin('POST', { ...base, 'sec-fetch-site': '' }), false, 'present, even empty');
  assert.equal(shouldDropOrigin('POST', { ...base, origin: 'https://evil.example' }), false);
  assert.equal(shouldDropOrigin('POST', { ...base, origin: 'https://ha.example.com' }), false, 'port differs');
  assert.equal(shouldDropOrigin('POST', { ...base, origin: 'null' }), false);
  assert.equal(shouldDropOrigin('POST', { origin: base.origin }), false, 'no X-Forwarded-Host');
  assert.equal(shouldDropOrigin('POST', { 'x-forwarded-host': 'ha.example.com:8123' }), false, 'no Origin');
});

test('ingress response rewrite: framing for HA, no session cookie, prefixed redirect', () => {
  const h = rewriteIngressResponse({
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'",
    'set-cookie': ['gymsid=abc; Path=/; HttpOnly', '__Host-gymsid=def; Path=/; Secure', 'other=1; Path=/'],
    location: '/?x=1',
  }, '/api/hassio_ingress/TOKEN');
  assert.equal(h['x-frame-options'], 'SAMEORIGIN');
  assert.equal(h['content-security-policy'], "frame-ancestors 'self'");
  assert.deepEqual(h['set-cookie'], ['other=1; Path=/']);
  assert.equal(h.location, '/api/hassio_ingress/TOKEN/?x=1');
});

test('ingress response rewrite: only-session Set-Cookie removed entirely; absolute Location untouched', () => {
  const h = rewriteIngressResponse({ 'set-cookie': ['gymsid=; Path=/; Max-Age=0'], location: 'https://elsewhere.example/x' }, '/api/hassio_ingress/T/');
  assert.equal('set-cookie' in h, false);
  assert.equal(h.location, 'https://elsewhere.example/x');
  const none = rewriteIngressResponse({ location: '/x' }, undefined);
  assert.equal(none.location, '/x', 'no X-Ingress-Path -> nothing to prefix');
  const noHeaders = rewriteIngressResponse({}, '/p');
  assert.deepEqual(noHeaders, {}, 'nothing added that was not there');
});
