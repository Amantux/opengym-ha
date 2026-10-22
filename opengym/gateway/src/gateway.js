// The gateway: first hop for every request on port 8099 (contract §6, §7).
//
//   /healthz            -> the api's own health check, for every peer
//   /ha/v1/*            -> the integration API (Bearer integration token), for every peer
//   ingress peer        -> session for the HA user, then nginx, with framing allowed for HA
//   any other peer      -> nginx untouched when direct access is on, else 403
import http from 'node:http';
import { callApi, ApiUnavailable } from './api.js';
import { logBodyWeight } from './bodyweight.js';
import { InternalUnavailable } from './internal.js';
import { addSessionCookie, ingressMethod, LENGTH_HEADER, METHOD_HEADER, rewriteIngressResponse, tunnelledLength, shouldDropOrigin, stripSessionCookies, utf8FromHeader } from './ingress.js';
import { BadRequest, readJsonBody, sendJson } from './json.js';
import { NOT_RESPONDING, proxyRequest, withoutHopByHop } from './proxy.js';
import { buildSummary, createStateReader } from './summary.js';
import { bearerMatches } from './token.js';

// The Supervisor's ingress proxy. Exactly this address, not the hassio /23: the network's
// gateway (.1) is inside that range and is what host-published ports arrive from, so a range
// check would trust forged identity headers from the LAN. Deliberately not configurable.
export const INGRESS_PEER = '172.30.32.2';

/** The TCP peer of the request, IPv4-mapped IPv6 shown as plain IPv4. */
export function socketPeer(req) {
  const addr = req.socket.remoteAddress || '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

export const DIRECT_OFF = { error: "Direct access is turned off. Open openGym from the Home Assistant sidebar, or set the add-on's external_url option." };
const UNAUTHORIZED = { error: 'unauthorized' };
const NOT_FOUND = { error: 'not found' };

// Log lines carry names HA users chose themselves: no control characters (C0, DEL, C1 — a
// UTF-8 name can decode to U+0085 NEL) and no Unicode line separators, so no forged lines.
const printable = s => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');

/**
 * Headers for any proxied request: hop-by-hop removed, every X-Remote-User-* removed (only the
 * gateway decides who a request is), and the client address set from the socket — never taken
 * from what the client claims.
 */
export function forwardHeaders(req, peer) {
  const headers = withoutHopByHop(req.headers);
  for (const name of Object.keys(headers)) if (name.startsWith('x-remote-user-')) delete headers[name];
  delete headers[METHOD_HEADER];
  delete headers[LENGTH_HEADER];
  headers['x-forwarded-for'] = peer;
  headers['x-real-ip'] = peer;
  delete headers['cf-connecting-ip'];
  return headers;
}

/**
 * The request handler. `config`: { directAccess, webUrl, apiUrl, integrationToken, version,
 * opengymVersion, dataDir, envTz }. `internal`: createInternalClient(). `effectiveRoutineId`:
 * upstream queue.js. `peerOf` is injectable for tests only; production uses the socket.
 */
export function createGateway({ config, internal, effectiveRoutineId, peerOf = socketPeer, log = console, now = () => Date.now() }) {
  const web = new URL(config.webUrl);
  const reader = createStateReader(config.dataDir);

  async function health(req, res) {
    try {
      const { status, json } = await callApi(config.apiUrl, 'GET', '/api/health', { timeoutMs: 5_000 });
      // Our own api's health answer ({ok, users, writable}); re-serialised, so only JSON passes.
      if (json && typeof json === 'object') return sendJson(res, status, json);
      return sendJson(res, 502, NOT_RESPONDING);
    } catch (err) {
      if (err instanceof ApiUnavailable) return sendJson(res, 502, NOT_RESPONDING);
      throw err;
    }
  }

  async function integration(req, res, pathname) {
    if (pathname === '/ha/v1/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, version: config.version, opengym_version: config.opengymVersion });
    }
    if (!bearerMatches(req.headers.authorization, config.integrationToken)) return sendJson(res, 401, UNAUTHORIZED);
    try {
      if (pathname === '/ha/v1/profiles' && req.method === 'GET') {
        const users = await internal.users();
        return sendJson(res, 200, { profiles: users.filter(u => !u.disabled).map(u => ({ id: u.id, name: u.name, admin: u.admin === true })) });
      }
      if (pathname === '/ha/v1/summary' && req.method === 'GET') {
        const users = await internal.users();
        return sendJson(res, 200, await buildSummary(users, { reader, now: now(), envTz: config.envTz, effectiveRoutineId }));
      }
      const m = /^\/ha\/v1\/profiles\/([^/]+)\/bodyweight$/.exec(pathname);
      if (m && req.method === 'POST') {
        let profileId;
        try { profileId = decodeURIComponent(m[1]); } catch { return sendJson(res, 404, { error: 'unknown profile' }); }
        let body;
        try { body = await readJsonBody(req); } catch (err) {
          if (err instanceof BadRequest) return sendJson(res, 400, { error: err.message });
          throw err;
        }
        const out = await logBodyWeight({ profileId, body, internal, apiUrl: config.apiUrl, now, envTz: config.envTz });
        return sendJson(res, out.status, out.body);
      }
      return sendJson(res, 404, NOT_FOUND);
    } catch (err) {
      if (err instanceof InternalUnavailable) return sendJson(res, 502, NOT_RESPONDING);
      throw err;
    }
  }

  async function ingress(req, res, pathname, peer) {
    const headers = forwardHeaders(req, peer);
    // 1. The minted session must be the only credential: drop the client's own session cookies
    //    (a direct-port sign-in on the same host name rides along, cookies ignore ports) and any
    //    Authorization, with or without an identity on this request.
    const cookie = stripSessionCookies(headers.cookie);
    if (cookie === undefined) delete headers.cookie; else headers.cookie = cookie;
    delete headers.authorization;

    // 2. The HA user's session, for api calls only — static files need none.
    const haUserId = req.headers['x-remote-user-id'];
    if (haUserId && pathname.startsWith('/api/')) {
      const name = utf8FromHeader(req.headers['x-remote-user-display-name'] || req.headers['x-remote-user-name'] || '');
      let session;
      try { session = await internal.haSession(haUserId, name); } catch (err) {
        // Not anonymous: a 401 would make the app drop the signed-in user; a 502 keeps its copy
        // and retries, which is what "the backend is briefly down" should look like.
        if (err instanceof InternalUnavailable) return sendJson(res, 502, NOT_RESPONDING);
        throw err;
      }
      if (session.created && session.user.admin === true) {
        log.log(`openGym: HA user ${printable(session.user.name)} is the openGym admin (first profile on this instance)`);
      }
      // A disabled profile gets no token and goes on anonymously: upstream's own sign-in screen.
      if (session.token) headers.cookie = addSessionCookie(headers.cookie, session.token);
    }

    // 3. Never a Bearer (upstream skips CSRF for Bearer callers). Origin only for the narrow
    //    no-Sec-Fetch-Site case, see shouldDropOrigin.
    if (shouldDropOrigin(req.method, headers)) delete headers.origin;

    // 4. Response rewrites for HA's frame.
    const ingressPath = req.headers['x-ingress-path'];
    // 5. A media upload the page sent as POST goes on as its PUT, with its real length (see
    //    ingressMethod, tunnelledLength).
    const method = ingressMethod(req.method, pathname, req.headers);
    const bodyLength = method === req.method ? undefined : tunnelledLength(method, req.headers);
    proxyRequest(req, res, { target: web, method, headers, bodyLength, rewriteResponseHeaders: h => rewriteIngressResponse(h, ingressPath), log });
  }

  return async function handle(req, res) {
    try {
      const pathname = (req.url || '/').split('?')[0];
      if (pathname === '/healthz') return await health(req, res);
      if (pathname === '/ha/v1' || pathname.startsWith('/ha/v1/')) return await integration(req, res, pathname);
      const peer = peerOf(req);
      if (peer === INGRESS_PEER) return await ingress(req, res, pathname, peer);
      if (!config.directAccess) return sendJson(res, 403, DIRECT_OFF);
      return proxyRequest(req, res, { target: web, headers: forwardHeaders(req, peer), log });
    } catch (err) {
      // A bug, not an expected failure: the stack goes to the add-on log, the client gets a
      // fixed message.
      log.error('openGym gateway: unexpected error', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    }
  };
}

/** The HTTP server with the contract's timeouts. */
export function createHttpServer(handler) {
  const server = http.createServer(handler);
  server.requestTimeout = 30 * 60 * 1000; // a 48 MB workout video over a slow phone link
  server.headersTimeout = 60 * 1000;
  // Longer than aiohttp's 15 s keep-alive reuse window: the Supervisor must never pick a pooled
  // connection this server is closing at that very moment (a stale-socket 502 in the panel).
  server.keepAliveTimeout = 65 * 1000;
  return server;
}
