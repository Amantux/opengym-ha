// A stand-in for the Supervisor API, for tests/e2e/run.sh's "under the Supervisor" phase. It runs
// in a node container on the e2e network under the DNS name `supervisor`, the name the add-on
// calls, and answers the three calls the add-on makes: GET /info (Home Assistant's time zone),
// GET /addons/self/info (the hostname discovery announces) and POST /discovery.
//
//   HOLD_MS=8000 INFO_HOLD_MS=2000 node supervisor-stub.mjs
//
// Every request is printed as one JSON line {method, url, auth, body} the moment it has arrived
// (body parsed when it is JSON), so run.sh asserts on exactly what the add-on sent. The answer to
// GET /addons/self/info is held for HOLD_MS (below discovery's 10 s timeout), so the discovery
// process is alive, holding the Supervisor token, while run.sh inspects the add-on's processes.
// INFO_HOLD_MS does the same for GET /info (below the time-zone lookup's 3 s timeout), so the
// boot-time lookup can be inspected too.
import http from 'node:http';

const HOLD_MS = Number(process.env.HOLD_MS) || 0;
const INFO_HOLD_MS = Number(process.env.INFO_HOLD_MS) || 0;

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = raw || null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON: keep the text */ }
    console.log(JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body }));
    if (req.method === 'GET' && req.url === '/info') {
      setTimeout(() => reply(res, 200, { result: 'ok', data: { timezone: 'Europe/Lisbon' } }), INFO_HOLD_MS);
    } else if (req.method === 'GET' && req.url === '/addons/self/info') {
      setTimeout(() => reply(res, 200, { result: 'ok', data: { hostname: 'local-opengym' } }), HOLD_MS);
    } else if (req.method === 'POST' && req.url === '/discovery') {
      reply(res, 200, { result: 'ok', data: { uuid: 'e2e-discovery' } });
    } else {
      reply(res, 404, { result: 'error', message: 'not part of the stub' });
    }
  });
}).listen(80, () => console.log('supervisor stub listening on :80'));
