// The page-side half of the ingress upload tunnel (web/ha-ingress.js), run in a vm context with
// a stand-in XMLHttpRequest that records what the app's upload would actually send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(new URL('../web/ha-ingress.js', import.meta.url), 'utf8');
const HASH = 'ab'.repeat(32);
const TOKEN_PATH = '/api/hassio_ingress/Zx9_tok-1/';

function page(href) {
  const sent = [];
  class FakeXHR {
    open(method, url) { this.method = method; this.url = url; this.headers = {}; sent.push(this); }
    setRequestHeader(k, v) { this.headers[k] = v; }
  }
  const location = new URL(href);
  const window = { XMLHttpRequest: FakeXHR };
  const ctx = vm.createContext({ window, location, URL });
  vm.runInContext(SOURCE, ctx);
  // Twice, as a reloaded script would: it must not wrap itself.
  vm.runInContext(SOURCE, ctx);
  return { XHR: FakeXHR, sent };
}

const upload = (XHR, method, url) => { const x = new XHR(); x.open(method, url); return x; };

test('under ingress, a media PUT goes out as POST with X-OpenGym-Method: PUT', () => {
  const { XHR } = page(`https://ha.example:8123${TOKEN_PATH}#/exercises`);
  for (const url of [`${TOKEN_PATH}api/media/${HASH}`, `https://ha.example:8123${TOKEN_PATH}api/media/${HASH}`]) {
    const x = upload(XHR, 'PUT', url);
    assert.equal(x.method, 'POST', url);
    assert.deepEqual(x.headers, { 'X-OpenGym-Method': 'PUT' }, url);
  }
  assert.equal(upload(XHR, 'put', `${TOKEN_PATH}api/media/${HASH}`).method, 'POST');
});

test('everything else is left exactly as the app opened it', () => {
  const { XHR } = page(`https://ha.example:8123${TOKEN_PATH}`);
  const cases = [
    ['GET', `${TOKEN_PATH}api/media/${HASH}`],            // a download
    ['POST', `${TOKEN_PATH}api/media/missing`],            // the app's own POSTs
    ['PUT', `${TOKEN_PATH}api/data`],                      // the state sync
    ['PUT', `${TOKEN_PATH}api/media/${HASH.slice(2)}`],    // not a sha256
    ['PUT', `${TOKEN_PATH}api/media/${HASH}?x=1`],         // not the bare route
    ['PUT', `/api/hassio_ingress/other/api/media/${HASH}`], // another add-on's ingress path
    ['PUT', `/api/media/${HASH}`],                         // Home Assistant's own API
    ['PUT', `/x${TOKEN_PATH}api/media/${HASH}`],              // not under the ingress root
    ['PUT', `https://elsewhere.example${TOKEN_PATH}api/media/${HASH}`], // another origin
  ];
  for (const [method, url] of cases) {
    const x = upload(XHR, method, url);
    assert.equal(x.method, method, `${method} ${url}`);
    assert.deepEqual(x.headers, {}, `${method} ${url}`);
  }
});

test('outside ingress (direct access) the script changes nothing', () => {
  const { XHR } = page('https://gym.example.com/#/home');
  const x = upload(XHR, 'PUT', `/api/media/${HASH}`);
  assert.equal(x.method, 'PUT');
  assert.deepEqual(x.headers, {});
});

// The script only helps while upstream uploads with an XMLHttpRequest PUT that it looks up at
// call time. A release that switches to fetch() or captures the constructor early would quietly
// bring the 16 MiB limit back, so CI (which sets UPSTREAM_SRC) re-reads the real source.
test('upstream still uploads media with XMLHttpRequest PUT (when UPSTREAM_SRC is set)', { skip: !process.env.UPSTREAM_SRC && 'UPSTREAM_SRC not set' }, () => {
  const api = fs.readFileSync(new URL(`file://${process.env.UPSTREAM_SRC}/frontend/src/lib/api.js`), 'utf8');
  const upload = api.slice(api.indexOf('export function apiUpload'));
  assert.ok(api.includes('export function apiUpload('), 'apiUpload exists');
  assert.match(upload, /XHR = globalThis\.XMLHttpRequest/, 'the constructor is read at call time');
  assert.match(upload, /xhr\.open\('PUT', mediaUrl\(path\)\)/, 'uploads are an XHR PUT');
  const sync = fs.readFileSync(new URL(`file://${process.env.UPSTREAM_SRC}/frontend/src/lib/media-sync.js`), 'utf8');
  assert.match(sync, /apiUpload\('\/api\/media\/' \+ h,/, 'media sync uploads through apiUpload');
});
