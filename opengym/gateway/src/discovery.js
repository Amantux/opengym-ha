// Supervisor discovery (contract §8): tell Home Assistant where the add-on is and which token to
// use, so the companion integration is offered with zero typing. Best effort by design — every
// failure is logged with what was skipped, and nothing here can stop the add-on.
import fs from 'node:fs';
import path from 'node:path';

const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const GATEWAY_PORT = 8099;

const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));

/** `fn` up to `attempts` times, sleeping base * 2^i between tries (2+4+8+16+32 s ≈ 1 min of waits). */
async function retry(fn, { what, attempts, baseDelayMs, sleep, log }) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) {
      // err.message is always one of ours below (a status code or "unreachable"), never a body.
      log(`openGym discovery: ${what} failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      if (i === attempts - 1) throw err;
      await sleep(baseDelayMs * 2 ** i);
    }
  }
  return undefined;
}

async function fetchJson(fetchImpl, url, init) {
  let res;
  try { res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) }); } catch {
    throw new Error('unreachable');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try { return await res.json(); } catch { return null; }
}

/** Wait for our own /healthz (the api behind it is up), at most `timeoutMs`. */
async function waitForGateway({ fetchImpl, gatewayUrl, timeoutMs, pollMs, sleep }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetchImpl(`${gatewayUrl}/healthz`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    if (Date.now() + pollMs > deadline) return false;
    await sleep(pollMs);
  }
}

/**
 * Runs the whole discovery and resolves to { status: 'sent' | 'skipped' | 'failed', reason? }.
 * Never throws. `sleep`, `baseDelayMs` and `fetchImpl` exist for the tests.
 */
export async function runDiscovery({
  env = process.env,
  log = msg => console.log(msg),
  fetchImpl = globalThis.fetch,
  sleep = sleepMs,
  baseDelayMs = 2_000,
  readyTimeoutMs = 60_000,
  readyPollMs = 2_000,
} = {}) {
  const supervisorToken = env.SUPERVISOR_TOKEN;
  if (!supervisorToken) {
    log('openGym discovery: not running under the Supervisor, discovery skipped');
    return { status: 'skipped', reason: 'no-supervisor' };
  }
  const supervisor = (env.SUPERVISOR_API || 'http://supervisor').replace(/\/+$/, '');
  const port = Number(env.GATEWAY_PORT) || GATEWAY_PORT;
  const auth = { Authorization: `Bearer ${supervisorToken}` };

  const ready = await waitForGateway({ fetchImpl, gatewayUrl: `http://127.0.0.1:${port}`, timeoutMs: readyTimeoutMs, pollMs: readyPollMs, sleep });
  if (!ready) log('openGym discovery: the gateway did not answer /healthz in time; announcing anyway (the integration probes before it offers setup)');

  let token;
  try { token = fs.readFileSync(path.join(env.GATEWAY_STATE_DIR || '/data/gateway', 'integration_token'), 'utf8').trim(); } catch { token = ''; }
  if (!token) {
    log('openGym discovery: no integration token on disk yet, discovery skipped');
    return { status: 'skipped', reason: 'no-token' };
  }

  // The DNS name HA Core resolves is the Supervisor-assigned hostname, which this container does
  // not know: $HOSTNAME is the Docker container id and points nowhere. No hostname, no
  // announcement — a payload HA cannot reach is worse than none.
  let host = '';
  try {
    const info = await retry(() => fetchJson(fetchImpl, `${supervisor}/addons/self/info`, { headers: auth }),
      { what: 'reading the add-on hostname', attempts: 6, baseDelayMs, sleep, log });
    host = typeof info?.data?.hostname === 'string' ? info.data.hostname.trim() : '';
  } catch { host = ''; }
  if (!host || !HOSTNAME.test(host)) {
    log('openGym discovery: the Supervisor did not report this add-on\'s hostname, discovery skipped (the container id is never announced)');
    return { status: 'skipped', reason: 'no-hostname' };
  }

  const payload = { service: 'opengym', config: { host, port, token } };
  try {
    await retry(() => fetchJson(fetchImpl, `${supervisor}/discovery`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }), { what: 'announcing to the Supervisor', attempts: 6, baseDelayMs, sleep, log });
  } catch {
    log('openGym discovery: the Supervisor did not accept the announcement; add the integration by hand or restart the add-on');
    return { status: 'failed', reason: 'discovery-refused' };
  }
  log(`openGym discovery: announced ${host}:${port} to Home Assistant`);
  return { status: 'sent' };
}
