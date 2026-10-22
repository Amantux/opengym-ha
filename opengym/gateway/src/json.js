// Small JSON helpers shared by the gateway's own routes.

/** Curated JSON answer. Callers pass fixed strings, never an exception's text or an upstream body. */
export function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

export class BadRequest extends Error {}

/** A small JSON request body (the integration API only takes a handful of fields). */
export function readJsonBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        // Keep reading and discard, so the client gets the 400 instead of a reset connection.
        req.resume();
        reject(new BadRequest('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text.trim() ? JSON.parse(text) : {}); } catch { reject(new BadRequest('request body is not valid JSON')); }
    });
    req.on('error', err => { if (!done) { done = true; reject(err); } });
  });
}
