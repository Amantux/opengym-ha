// The integration token: the credential the HA integration sends as `Authorization: Bearer` on
// /ha/v1. Generated once, persisted under the data dir (so it survives restarts and backups),
// handed to HA only through Supervisor discovery, and never logged.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,}$/;

/**
 * The token in `<stateDir>/integration_token`, creating it (mode 0600) when it is missing.
 * A file that does not hold a token (empty after a crash mid-write, edited by hand) is replaced:
 * an empty token must never be the thing a Bearer is compared against. The next discovery
 * re-advertises the new one.
 */
export function ensureIntegrationToken(stateDir, log = console) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, 'integration_token');
  let existing = null;
  try { existing = fs.readFileSync(file, 'utf8').trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (existing !== null && TOKEN_SHAPE.test(existing)) return existing;
  if (existing !== null) log.warn('openGym gateway: the integration token file held no valid token; a new one was generated');
  const token = crypto.randomBytes(32).toString('base64url');
  // Temporary file + rename: a crash leaves either no token or a whole one, never half.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // the mode above is masked by the umask only downwards; be explicit anyway
  fs.renameSync(tmp, file);
  return token;
}

/**
 * Constant-time check of an `Authorization` header against the integration token. Both sides
 * are hashed first so timingSafeEqual always compares 32 bytes: neither the token's length nor
 * how many leading characters a guess got right shows up in the response time.
 */
export function bearerMatches(header, expected) {
  // An empty token must never be what a Bearer is compared against: "" would match a header
  // that carries no token at all.
  if (typeof expected !== 'string' || !expected) return false;
  const m = /^Bearer +(\S+) *$/i.exec(typeof header === 'string' ? header : '');
  const given = m ? m[1] : '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
