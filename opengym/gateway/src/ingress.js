// Request and response rewrites for requests from the HA ingress peer (contract §6).
//
// Under ingress openGym shares Home Assistant's origin, so two things have to hold: the only
// session that reaches the api is the one the gateway minted for the HA user, and the api's
// anti-framing headers must allow HA's own page to frame it (otherwise the panel is blank).

// Upstream reads both names (server.js cookieToken: `__Host-gymsid` on an https ORIGIN, the
// legacy `gymsid` always). A client copy of either could carry a direct-port sign-in into an
// ingress request — cookies ignore ports — so both are removed before the minted one goes on.
export const SESSION_COOKIES = new Set(['gymsid', '__Host-gymsid']);

const cookieName = pair => {
  const i = pair.indexOf('=');
  return (i < 0 ? pair : pair.slice(0, i)).trim();
};

/** The Cookie header without any session cookie pair, or undefined when nothing is left. */
export function stripSessionCookies(cookie) {
  if (!cookie) return undefined;
  const kept = String(cookie).split(';').map(s => s.trim()).filter(p => p && !SESSION_COOKIES.has(cookieName(p)));
  return kept.length ? kept.join('; ') : undefined;
}

/** Append the minted session. Called on a header that stripSessionCookies already cleaned. */
export function addSessionCookie(cookie, token) {
  return cookie ? `${cookie}; gymsid=${token}` : `gymsid=${token}`;
}

/**
 * Node hands header bytes over as latin1, one char per byte. The Supervisor sends names as
 * UTF-8, so "Zoë" arrives as "ZoÃ«"; re-reading the same bytes as UTF-8 gives the name back.
 */
export function utf8FromHeader(value) {
  if (typeof value !== 'string') return '';
  return Buffer.from(value, 'latin1').toString('utf8');
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether to delete Origin before forwarding (contract §6 step 3). Upstream's CSRF check trusts
 * Sec-Fetch-Site when present and otherwise compares Origin with its configured ORIGIN, which
 * under ingress is never HA's address. Browsers without Sec-Fetch-Site (old WebKit, companion
 * app WebViews) would then fail every write. When the Origin is HA's own host — the one the
 * Supervisor reports in X-Forwarded-Host — the request came from HA's page, and dropping Origin
 * makes upstream treat it as a non-browser call. A present Sec-Fetch-Site is never touched:
 * upstream's own check on it is the stronger one.
 */
export function shouldDropOrigin(method, headers) {
  if (SAFE_METHODS.has(String(method).toUpperCase())) return false;
  if (headers['sec-fetch-site'] !== undefined) return false;
  const origin = headers.origin;
  const forwardedHost = headers['x-forwarded-host'];
  if (!origin || !forwardedHost) return false;
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  return host !== '' && host.toLowerCase() === String(forwardedHost).trim().toLowerCase();
}

const setCookieName = line => cookieName(String(line).split(';')[0]);

/**
 * Ingress response rewrites, applied in place to the upstream response headers:
 * - framing allowed for HA's own page (SAMEORIGIN / frame-ancestors 'self') — still not for
 *   anyone else's;
 * - no session Set-Cookie: the minted session lives only inside the gateway, and a 90-day
 *   cookie must not be planted on HA's origin;
 * - a root-relative redirect stays under the ingress prefix instead of landing on HA's own root.
 */
export function rewriteIngressResponse(headers, ingressPath) {
  if (headers['x-frame-options'] !== undefined) headers['x-frame-options'] = 'SAMEORIGIN';
  const csp = headers['content-security-policy'];
  if (csp !== undefined) {
    const fix = v => String(v).replace(/frame-ancestors\s+'none'/gi, "frame-ancestors 'self'");
    headers['content-security-policy'] = Array.isArray(csp) ? csp.map(fix) : fix(csp);
  }
  const cookies = headers['set-cookie'];
  if (cookies !== undefined) {
    const kept = [].concat(cookies).filter(line => !SESSION_COOKIES.has(setCookieName(line)));
    if (kept.length) headers['set-cookie'] = kept; else delete headers['set-cookie'];
  }
  const location = headers.location;
  const prefix = typeof ingressPath === 'string' ? ingressPath.replace(/\/+$/, '') : '';
  if (typeof location === 'string' && location.startsWith('/') && prefix.startsWith('/')) {
    headers.location = prefix + location;
  }
  return headers;
}
