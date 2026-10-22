// The proxy streams bodies in both directions (never buffered), survives a client that hangs
// up mid-upload, and answers a curated 502 when nginx is not there.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
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

// A chunked body starting at buf[from]: { data, end } once its last chunk is in, else null.
function dechunk(buf, from) {
  let data = '';
  for (let at = from; ;) {
    const eol = buf.indexOf('\r\n', at);
    if (eol === -1) return null;
    const size = parseInt(buf.slice(at, eol), 16);
    if (size === 0) return buf.length >= eol + 4 ? { data, end: eol + 4 } : null;
    if (buf.length < eol + 2 + size + 2) return null;
    data += buf.slice(eol + 2, eol + 2 + size);
    at = eol + 4 + size;
  }
}

// Raw TCP "nginx": records every byte per connection and splits it into messages the way a real
// HTTP/1.1 parser would for these requests (no Content-Length is ever sent: a head ends the
// message unless it says chunked, then the body runs to the last chunk). Answers each one.
async function startRawNginx() {
  const conns = [];
  const sockets = new Set();
  const server = net.createServer(sock => {
    sockets.add(sock);
    const conn = { raw: '', messages: [] };
    conns.push(conn);
    let buf = '';
    sock.on('data', d => {
      conn.raw += d.toString('latin1');
      buf += d.toString('latin1');
      for (;;) {
        const headEnd = buf.indexOf('\r\n\r\n');
        if (headEnd === -1) return;
        const head = buf.slice(0, headEnd);
        let body = { data: '', end: headEnd + 4 };
        if (/\r\ntransfer-encoding: *chunked\r?$/im.test(head)) {
          body = dechunk(buf, headEnd + 4);
          if (!body) return;
        }
        conn.messages.push({ head, body: body.data });
        buf = buf.slice(body.end);
        sock.write('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
      }
    });
    sock.on('error', () => {});
  });
  const { port } = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address())));
  return { conns, url: `http://127.0.0.1:${port}`, close: () => new Promise(r => { for (const c of sockets) c.destroy(); server.close(() => r()); }) };
}

/** Write `bytes` on a fresh TCP connection and collect everything until the server closes it. */
function rawExchange(port, bytes) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(bytes, 'latin1'));
    let out = '';
    s.on('data', d => { out += d.toString('latin1'); });
    s.on('close', () => resolve(out));
    s.on('error', reject);
  });
}

test('a chunked body stays chunked to nginx for every method, so nothing rides behind it as a second request', async () => {
  // node chunk-encodes POST/PUT/PATCH bodies on its own; for these it would send the body bytes
  // with no framing at all, and nginx would read them as the next request on the connection.
  const smuggled = 'GET /SMUGGLED HTTP/1.1\r\nHost: x\r\nX-Remote-User-Id: admin\r\nX-Forwarded-For: 172.30.32.2\r\n\r\n';
  const chunked = `${smuggled.length.toString(16)}\r\n${smuggled}\r\n0\r\n\r\n`;
  const methods = ['GET', 'HEAD', 'DELETE', 'OPTIONS', 'POST'];
  for (const [peer, directAccess] of [['192.168.1.9', true], [INGRESS_PEER, false]]) {
    const web = await startRawNginx();
    cleanups.push(web.close);
    const gw = track(await startGateway({ peer, config: { webUrl: web.url, directAccess } }));
    for (const method of methods) {
      const out = await within(rawExchange(gw.port, `${method} /api/x HTTP/1.1\r\nHost: gw\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunked}`), 5_000, `${method} answered`);
      assert.match(out, /^HTTP\/1\.1 200 /, `${method} via ${peer}`);
    }
    // One keep-alive connection carried all of them, each exactly one framed message.
    assert.equal(web.conns.length, 1, `one upstream connection via ${peer}`);
    const { messages, raw } = web.conns[0];
    assert.deepEqual(messages.map(m => m.head.split('\r\n')[0]), methods.map(m => `${m} /api/x HTTP/1.1`), `request lines nginx parsed via ${peer}`);
    assert.doesNotMatch(raw, /(^|\r\n\r\n)GET \/SMUGGLED/, 'the body never starts a request of its own');
    for (const m of messages) {
      assert.match(m.head, /\r\ntransfer-encoding: chunked(\r\n|$)/i, m.head.split('\r\n')[0]);
      assert.equal(m.body, smuggled, `${m.head.split('\r\n')[0]} carries the whole body, as data`);
    }
  }
});
