// Entry point: node /opt/gateway/src/server.js (run as `app` by the entrypoint).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGateway, createHttpServer } from './gateway.js';
import { createInternalClient } from './internal.js';
import { resolveOptionsFile } from './options.js';
import { ensureIntegrationToken } from './token.js';

const env = process.env;

const { resolved, problems } = resolveOptionsFile(env.OPENGYM_OPTIONS_FILE || '/data/options.json');
if (!resolved) {
  for (const p of problems) console.error(`openGym gateway: ${p}`);
  process.exit(1);
}

const integrationToken = ensureIntegrationToken(env.GATEWAY_STATE_DIR || '/data/gateway');

// "Today's routine" is upstream's own rule (the one its reminders use), imported from the api
// tree rather than copied, so it can never drift. A missing file is a broken image: fail now.
const upstreamApiDir = env.UPSTREAM_API_DIR || '/app';
const { effectiveRoutineId } = await import(pathToFileURL(path.join(upstreamApiDir, 'queue.js')).href);
if (typeof effectiveRoutineId !== 'function') {
  console.error(`openGym gateway: ${upstreamApiDir}/queue.js has no effectiveRoutineId export`);
  process.exit(1);
}

const handler = createGateway({
  config: {
    directAccess: resolved.DIRECT_ACCESS === 'true',
    webUrl: env.UPSTREAM_WEB_URL || 'http://127.0.0.1:8080',
    apiUrl: env.UPSTREAM_API_URL || 'http://127.0.0.1:3000',
    integrationToken,
    version: env.OPENGYM_HA_VERSION || 'unknown',
    opengymVersion: env.OPENGYM_VERSION || '1.4.1',
    dataDir: env.OPENGYM_DATA_DIR || '/data/opengym',
    envTz: env.TZ || '',
  },
  internal: createInternalClient({ socketPath: env.HA_INTERNAL_SOCKET || '/run/opengym/internal.sock' }),
  effectiveRoutineId,
});

const server = createHttpServer(handler);
server.listen(env.GATEWAY_PORT ? Number(env.GATEWAY_PORT) : 8099, '0.0.0.0', () => {
  console.log(`openGym gateway listening on :${server.address().port} (direct access ${resolved.DIRECT_ACCESS === 'true' ? 'on' : 'off'})`);
});

// The entrypoint forwards TERM/INT. Stop accepting, let in-flight requests finish briefly, then
// exit 0 so a normal `docker stop` is a clean stop and not a signal death.
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5_000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
