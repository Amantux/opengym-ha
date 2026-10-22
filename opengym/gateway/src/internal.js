// Client for the api's internal unix-socket listener (contract §5). Users and sessions come from
// upstream's own in-memory state through it, so "sign out everywhere", disables and deletes are
// always current; the gateway never reads db.json or the signing secret itself.
import http from 'node:http';

/** The internal listener could not be reached or answered something unusable. Message is curated. */
export class InternalUnavailable extends Error {
  constructor() { super('openGym is not responding'); }
}

function call(socketPath, method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      socketPath, method, path,
      headers: payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* json stays null */ }
        resolve({ status: res.statusCode, json });
      });
      res.on('error', () => reject(new InternalUnavailable()));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => reject(new InternalUnavailable()));
    req.end(payload ?? undefined);
  });
}

export function createInternalClient({ socketPath, timeoutMs = 10_000 }) {
  // One request per HA user at a time: a page load fires several /api/* calls at once, and the
  // first visit of a new user must create exactly one profile. Nothing is cached after the call
  // settles — every request asks again, so a disable or sign-out-everywhere applies at once.
  const inflight = new Map();

  return {
    /** POST /internal/ha-session -> { user, created, token }. */
    haSession(haUserId, name) {
      const pending = inflight.get(haUserId);
      if (pending) return pending;
      const p = call(socketPath, 'POST', '/internal/ha-session', { ha_user_id: haUserId, name }, timeoutMs)
        .then(({ status, json }) => {
          if (status !== 200 || !json || typeof json.user !== 'object' || !json.user) throw new InternalUnavailable();
          return { user: json.user, created: json.created === true, token: typeof json.token === 'string' && json.token ? json.token : null };
        })
        .finally(() => inflight.delete(haUserId));
      inflight.set(haUserId, p);
      return p;
    },

    /** POST /internal/session -> token string, or null for an unknown/disabled profile. */
    async session(uid) {
      const { status, json } = await call(socketPath, 'POST', '/internal/session', { uid }, timeoutMs);
      if (status === 404) return null;
      if (status !== 200 || !json || typeof json.token !== 'string' || !json.token) throw new InternalUnavailable();
      return json.token;
    },

    /** GET /internal/users -> [{ id, name, admin, disabled, ha }]. */
    async users() {
      const { status, json } = await call(socketPath, 'GET', '/internal/users', undefined, timeoutMs);
      if (status !== 200 || !json || !Array.isArray(json.users)) throw new InternalUnavailable();
      return json.users.filter(u => u && typeof u.id === 'string');
    },
  };
}
