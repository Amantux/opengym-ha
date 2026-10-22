// Direct calls to the upstream api over loopback (contract §1: only /api/health and
// GET/PUT /api/data, on behalf of the integration). JSON in and out, bounded in size and time.
import http from 'node:http';

export class ApiUnavailable extends Error {
  constructor() { super('openGym is not responding'); }
}

// A whole profile document comes back on GET /api/data; upstream caps a PUT body at 5 MB, so a
// stored document is at most that, plus the envelope.
const MAX_RESPONSE = 8 * 1024 * 1024;

/** -> { status, json } (json null when the body is not JSON). Network failure -> ApiUnavailable. */
export function callApi(apiUrl, method, path, { token = null, body, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, apiUrl);
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    // A Bearer, not a cookie: upstream skips its browser CSRF check for Bearer callers, which is
    // right for a server-to-server write that carries no browser Origin at all.
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = http.request(target, { method, headers, timeout: timeoutMs }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > MAX_RESPONSE) { req.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* stays null */ }
        resolve({ status: res.statusCode, json });
      });
      res.on('error', () => reject(new ApiUnavailable()));
      res.on('aborted', () => reject(new ApiUnavailable()));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => reject(new ApiUnavailable()));
    req.end(payload ?? undefined);
  });
}
