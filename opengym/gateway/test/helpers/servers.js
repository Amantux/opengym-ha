// Fakes for the gateway tests: nginx (TCP), the api's internal listener (unix socket), the api
// itself (TCP), and a raw HTTP client that sends exactly the headers a test names.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createGateway, createHttpServer } from '../../src/gateway.js';
import { createInternalClient } from '../../src/internal.js';

export const tmpDir = (prefix = 'gw-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export function listen(server, ...args) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(...args, () => resolve(server.address()));
  });
}

export function close(server) {
  return new Promise(resolve => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

const readAll = req => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

/**
 * Fake nginx. Records every request (method, url, headers, rawHeaders, body). `respond(req, res,
 * body)` decides the answer; the default is 200 "ok" with the `responseHeaders` given.
 */
export async function startFakeNginx({ respond = null, responseHeaders = {}, readBody = true } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const record = { method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders };
    seen.push(record);
    if (!readBody) return respond(req, res, record);
    record.body = await readAll(req).catch(() => null);
    if (respond) return respond(req, res, record);
    res.writeHead(200, { 'Content-Type': 'text/plain', ...responseHeaders });
    res.end('ok');
  });
  const conns = { count: 0 };
  server.on('connection', () => { conns.count += 1; });
  const { port } = await listen(server, 0, '127.0.0.1');
  return { server, seen, connections: () => conns.count, url: `http://127.0.0.1:${port}`, close: () => close(server) };
}

/**
 * Fake internal listener on a unix socket. `handlers` maps 'POST /internal/ha-session' etc. to
 * async (body) => [status, json]. Every call is recorded in `calls`.
 */
export async function startFakeInternal(handlers = {}) {
  const dir = tmpDir('gw-sock-');
  const socketPath = path.join(dir, 'internal.sock');
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const raw = await readAll(req);
    const body = raw.length ? JSON.parse(raw.toString('utf8')) : null;
    const key = `${req.method} ${req.url}`;
    calls.push({ key, body });
    const h = handlers[key];
    const [status, json] = h ? await h(body) : [404, { error: 'not found' }];
    const text = JSON.stringify(json);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(text);
  });
  await listen(server, socketPath);
  return { server, socketPath, calls, close: () => close(server) };
}

/** A fake ha-session handler: one profile per HA id, the first one admin, tokens "tok-<uid>". */
export function haSessionStore({ disabled = new Set(), delayMs = 0 } = {}) {
  const users = [];
  return {
    users,
    handler: async body => {
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      let user = users.find(u => u.ha === body.ha_user_id);
      let created = false;
      if (!user) {
        user = { id: 'u' + (users.length + 1), name: body.name || 'Home Assistant user', admin: users.length === 0, disabled: false, ha: body.ha_user_id };
        users.push(user);
        created = true;
      }
      const isDisabled = disabled.has(body.ha_user_id);
      return [200, { user: { id: user.id, name: user.name, admin: user.admin, disabled: isDisabled }, created, token: isDisabled ? null : `tok-${user.id}` }];
    },
  };
}

/** Fake api on TCP. `routes` maps 'GET /api/data' to async (req, body) => [status, json]. */
export async function startFakeApi(routes = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const raw = await readAll(req);
    const body = raw.length ? JSON.parse(raw.toString('utf8')) : null;
    const key = `${req.method} ${req.url}`;
    calls.push({ key, body, headers: req.headers });
    const h = routes[key];
    const [status, json] = h ? await h(req, body) : [404, { error: 'not found' }];
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(json));
  });
  const { port } = await listen(server, 0, '127.0.0.1');
  return { server, calls, url: `http://127.0.0.1:${port}`, close: () => close(server) };
}

export const TOKEN = 'T'.repeat(43);

/**
 * The real gateway handler on an ephemeral port. `peer` is what peerOf reports (the socket peer
 * is always 127.0.0.1 in tests); `config` overrides the defaults below.
 */
export async function startGateway({ peer = '127.0.0.1', config = {}, internal = null, socketPath = null, effectiveRoutineId = () => null, log = quietLog(), now } = {}) {
  const handler = createGateway({
    config: {
      directAccess: false, webUrl: 'http://127.0.0.1:9', apiUrl: 'http://127.0.0.1:9', integrationToken: TOKEN,
      version: '0.1.0', opengymVersion: '1.4.1', dataDir: tmpDir('gw-data-'), envTz: '', ...config,
    },
    internal: internal || createInternalClient({ socketPath: socketPath || path.join(tmpDir(), 'none.sock') }),
    effectiveRoutineId,
    peerOf: typeof peer === 'function' ? peer : () => peer,
    log,
    ...(now ? { now } : {}),
  });
  const server = createHttpServer(handler);
  const { port } = await listen(server, 0, '127.0.0.1');
  return { server, url: `http://127.0.0.1:${port}`, port, log, close: () => close(server) };
}

/** A console stand-in that records instead of printing. */
export function quietLog() {
  const lines = [];
  const rec = (...a) => lines.push(a.map(String).join(' '));
  return { lines, log: rec, warn: rec, error: rec, info: rec };
}

/**
 * Raw request. `headers` is an array of [name, value] pairs so duplicates and exact bytes
 * can be sent (a latin1 string carries raw bytes, e.g. UTF-8). -> { status, headers, body (Buffer) }.
 */
export function request(url, { method = 'GET', path: p = '/', headers = [], body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // With an array of headers node adds no Host of its own (verified on node 22), and a request
    // without one is a 400 from any HTTP/1.1 server.
    const pairs = headers.some(([n]) => n.toLowerCase() === 'host') ? headers : [['Host', u.host], ...headers];
    const req = http.request({ hostname: u.hostname, port: u.port, method, path: p, headers: pairs.flat() });
    req.on('response', res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body ?? undefined);
  });
}

export const json = r => JSON.parse(r.body.toString('utf8'));
export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
