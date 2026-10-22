// The proxy streams bodies in both directions (never buffered), survives a client that hangs
// up mid-upload, and answers a curated 502 when nginx is not there.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { INGRESS_PEER } from '../src/gateway.js';
import { json, request, sha256, startFakeNginx, startGateway } from './helpers/servers.js';

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });
const track = x => { cleanups.push(x.close); return x; };

const MB = 1024 * 1024;
// A deadline that does not keep the process alive once the promise has settled.
function within(promise, ms, what) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

test('a 20 MB upload streams through: nginx sees bytes before the client has sent them all', async () => {
  let received = 0;
  const hash = crypto.createHash('sha256');
  let firstBytes;
  const firstSeen = new Promise(resolve => { firstBytes = resolve; });
  const web = track(await startFakeNginx({
    readBody: false,
    respond: (req, res) => {
      req.on('data', c => { received += c.length; hash.update(c); firstBytes(); });
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ received, sha: hash.digest('hex') })); });
    },
  }));
  const gw = track(await startGateway({ peer: INGRESS_PEER, config: { webUrl: web.url } }));

  const body = crypto.randomBytes(20 * MB);
  const req = http.request(`${gw.url}/api/media/upload`, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': body.length } });
  const response = once(req, 'response');
  req.write(body.subarray(0, MB));
  // A buffering proxy would forward nothing until the whole 20 MB had arrived; this would hang.
  await within(firstSeen, 5_000, 'first upstream bytes while the upload is still in progress');
  assert.ok(received < body.length, 'upstream saw data before the client finished');
  for (let off = MB; off < body.length; off += MB) {
    if (!req.write(body.subarray(off, off + MB))) await once(req, 'drain');
  }
  req.end();
  const [res] = await within(response, 20_000, 'response');
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const out = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(res.statusCode, 200);
  assert.equal(out.received, body.length);
  assert.equal(out.sha, sha256(body));
});

test('a response streams back before upstream has finished it', async () => {
  let finish;
  const web = track(await startFakeNginx({
    readBody: false,
    respond: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('first chunk;');
      finish = () => res.end('last chunk');
    },
  }));
  const gw = track(await startGateway({ peer: INGRESS_PEER, config: { webUrl: web.url } }));
  const req = http.get(`${gw.url}/big.txt`);
  const [res] = await within(once(req, 'response'), 5_000, 'headers');
  const [first] = await within(once(res, 'data'), 5_000, 'first chunk while upstream is still open');
  assert.equal(first.toString(), 'first chunk;');
  finish();
  let rest = '';
  for await (const c of res) rest += c;
  assert.equal(rest, 'last chunk');
});

test('a client abort mid-upload cancels the upstream request, and the gateway keeps serving', async () => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const web = track(await startFakeNginx({
    readBody: false,
    respond: (req, res) => {
      if (req.url === '/after') { res.end('still here'); return; }
      req.on('data', () => {});
      // The proxy destroys its upstream request when the client goes away; nginx sees it close
      // before the body completed.
      req.on('close', () => upstreamClosed(req.complete));
    },
  }));
  const gw = track(await startGateway({ peer: INGRESS_PEER, config: { webUrl: web.url } }));
  const req = http.request(`${gw.url}/api/media/upload`, { method: 'PUT', headers: { 'Content-Length': 10 * MB } });
  req.on('error', () => {}); // we are about to kill it ourselves
  req.write(crypto.randomBytes(MB));
  await new Promise(r => setTimeout(r, 100));
  req.destroy();
  const complete = await within(closed, 5_000, 'upstream request closed after the client abort');
  assert.equal(complete, false, 'the upstream body never completed');
  const r = await request(gw.url, { path: '/after' });
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), 'still here');
});

test('nginx down: a curated 502, the socket error never reaches the client', async () => {
  for (const [peer, directAccess] of [[INGRESS_PEER, false], ['192.168.1.9', true]]) {
    const gw = track(await startGateway({ peer, config: { webUrl: 'http://127.0.0.1:9', directAccess } }));
    const r = await request(gw.url, { path: '/index.html' });
    assert.equal(r.status, 502);
    assert.deepEqual(json(r), { error: 'openGym is not responding' });
    assert.doesNotMatch(r.body.toString(), /ECONNREFUSED|127\.0\.0\.1/);
    assert.ok(gw.log.lines.some(l => l.includes('ECONNREFUSED')), 'the cause is in the add-on log instead');
  }
});

test('nginx dying mid-response cuts the client off instead of passing a short body as complete', async () => {
  const web = track(await startFakeNginx({
    readBody: false,
    respond: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 1000 });
      res.write('only part');
      setTimeout(() => res.socket.destroy(), 50);
    },
  }));
  const gw = track(await startGateway({ peer: INGRESS_PEER, config: { webUrl: web.url } }));
  const req = http.get(`${gw.url}/x`);
  const [res] = await within(once(req, 'response'), 5_000, 'headers');
  const ended = new Promise(resolve => {
    res.on('data', () => {});
    res.on('end', () => resolve('end'));
    res.on('error', () => resolve('error'));
    res.on('close', () => resolve(res.complete ? 'end' : 'cut'));
  });
  assert.notEqual(await within(ended, 5_000, 'client side closed'), 'end', 'the client must see an incomplete response');
});
