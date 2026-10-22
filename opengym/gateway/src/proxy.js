// Streaming reverse proxy (node:http only). Bodies are piped in both directions and never
// buffered: a 48 MB workout video goes through in constant memory.
import http from 'node:http';
import { sendJson } from './json.js';

// RFC 9110 §7.6.1 hop-by-hop headers: they describe one connection, not the message, so they are
// never forwarded. `expect` is answered by this server itself (node sends the 100 Continue), so
// passing it on would only make nginx send a second, unexpected 100.
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect'];

/** A copy of `headers` without hop-by-hop headers, including any the Connection header names. */
export function withoutHopByHop(headers) {
  const out = { ...headers };
  const named = String(headers.connection || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const h of [...HOP_BY_HOP, ...named]) delete out[h];
  return out;
}

export const NOT_RESPONDING = { error: 'openGym is not responding' };

/**
 * Forward `req` to `target` (a URL) with `headers`, and stream the answer back.
 * `rewriteResponseHeaders(headers)` may adjust the upstream response headers in place.
 */
export function proxyRequest(req, res, { target, headers, rewriteResponseHeaders = null, log = console }) {
  // The client can be gone already (it hung up while the gateway was minting its session); its
  // close events have fired, so an upstream request started now would never be cancelled.
  if (req.socket?.destroyed) return;
  // A chunked request body stays chunked. Transfer-Encoding is hop-by-hop and dropped above, and
  // node chunk-encodes an unframed body by default only for POST/PUT/PATCH: a GET, HEAD, DELETE
  // or OPTIONS body would go to nginx with no framing at all and be read as the next request on
  // the pooled connection (smuggled past forwardHeaders). Naming the coding makes node frame it
  // for every method. node's parser has already refused a request whose last coding is not
  // chunked, and one with a Content-Length as well.
  if (req.headers['transfer-encoding'] !== undefined) headers = { ...headers, 'transfer-encoding': 'chunked' };
  const upstream = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: req.url,
    headers,
  });

  upstream.on('response', up => {
    const out = withoutHopByHop(up.headers);
    if (rewriteResponseHeaders) rewriteResponseHeaders(out);
    res.writeHead(up.statusCode, up.statusMessage, out);
    up.pipe(res);
    // nginx going away mid-body: cut the client off too rather than leave it hanging (a short
    // body passed off as complete would be worse).
    up.on('close', () => { if (!up.complete) res.destroy(); });
    up.on('error', () => res.destroy());
  });

  let clientGone = false;
  upstream.on('error', err => {
    if (clientGone) return; // we destroyed it ourselves, below
    if (!res.headersSent) {
      // Curated: the client learns only that the app is down, never the socket error.
      log.error(`openGym gateway: upstream request failed (${err.code || 'error'})`);
      sendJson(res, 502, NOT_RESPONDING);
    } else {
      res.destroy();
    }
  });

  // The client hung up (closed the tab, cancelled an upload): stop the upstream request too, so
  // nginx and the api are not left reading a body nobody will finish. Either hook alone does it
  // (mutation-checked); the request's 'error' listener also keeps a reset upload from being an
  // unhandled 'error' event.
  res.on('close', () => {
    if (res.writableFinished) return;
    clientGone = true;
    upstream.destroy();
  });
  req.on('error', () => { clientGone = true; upstream.destroy(); });

  req.pipe(upstream);
}
