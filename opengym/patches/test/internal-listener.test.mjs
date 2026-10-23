/* The opengym-ha patch to upstream api/server.js (../0001-ha-internal-listener.patch): the
   internal listener on HA_INTERNAL_SOCKET and the HOST bind (docs/contract.md section 5).

   Every test runs the PATCHED upstream server.js in a child process against a data directory of
   its own, the way upstream's own server-*.test.js do, and talks to the socket the way the
   gateway does (http.request with socketPath). OPENGYM_API_DIR names the patched api directory:
   run-tests.sh sets it, and pointing it at /app runs the same tests inside the add-on image.

   Linux only: two checks read /proc, because "nothing listens on a unix socket" and "the TCP
   listener is bound to 127.0.0.1" are facts about the process that no request can show. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const API = process.env.OPENGYM_API_DIR || '';
if (!fs.existsSync(path.join(API, 'server.js'))) throw new Error('set OPENGYM_API_DIR to a patched openGym api directory');

const SECRET = crypto.randomBytes(32).toString('hex');
// An http ORIGIN, so upstream's session cookie is plain `gymsid` (`__Host-gymsid` needs https).
const ORIGIN = 'http://localhost:8080';
const INTERNAL = ['POST /internal/ha-session', 'POST /internal/session', 'GET /internal/users'];

/* One request, over TCP ({ port }) or the unix socket ({ socketPath }). node:http rather than
   fetch: fetch cannot reach a unix socket, and one client for both keeps the two comparable. */
function call(target, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      ...target, method, path: p, agent: false,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON; `text` still has it */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, text });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

/* POSTs every body to /internal/ha-session pipelined on one connection, in one write, and resolves
   with the raw responses once there is one per request. Pipelined, the server parses all of them
   in one go: every handler has read its body and reached the profile lookup before any of them
   carries on, the tightest interleaving there is, and the same on every run. Separate concurrent
   requests only sometimes line up that closely. */
function pipelined(socketPath, bodies) {
  return new Promise((resolve, reject) => {
    const s = net.connect(socketPath);
    let got = '';
    const statuses = () => (got.match(/^HTTP\/1\.1 \d+/gm) || []).length;
    s.on('data', d => { got += d; if (statuses() === bodies.length) s.end(); });
    s.on('error', reject);
    s.on('close', () => resolve(got));
    s.write(bodies.map(b => {
      const j = JSON.stringify(b);
      return `POST /internal/ha-session HTTP/1.1\r\nHost: internal\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(j)}\r\n\r\n${j}`;
    }).join(''));
  });
}

/* Resolves with the port once the child prints upstream's boot line, which it only does once the
   TCP listener is bound (and, with the patch, once the socket is bound and chmod'ed before it). */
function boundPort(child, tail) {
  return new Promise((resolve, reject) => {
    let seen = '';
    const give = setTimeout(() => reject(new Error(`server never announced a port:\n${tail()}`)), 20000);
    const look = d => {
      seen += d;
      const m = /gym-api on :(\d+)/.exec(seen);
      if (!m) return;
      clearTimeout(give);
      child.stdout.off('data', look);
      resolve(+m[1]);
    };
    child.stdout.on('data', look);
    child.once('exit', code => { clearTimeout(give); reject(new Error(`server exited (${code}):\n${tail()}`)); });
  });
}

/* Starts the patched server: HOST=127.0.0.1, PORT=0, FIRST_USER_ADMIN=1, a socket in a 0700
   directory of its own. `env` entries that are undefined are removed from the child's env. */
async function start(t, { env = {}, users = [], dir } = {}) {
  dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'og-ha-'));
  const data = path.join(dir, 'data');
  const run = path.join(dir, 'run');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(run, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(path.join(data, 'secret'))) fs.writeFileSync(path.join(data, 'secret'), SECRET, { mode: 0o600 });
  if (users.length) fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify({ users, creds: [], subs: [], invites: [] }));
  const sock = path.join(run, 'internal.sock');
  const childEnv = {
    ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: data, ORIGIN, RP_ID: 'localhost',
    FIRST_USER_ADMIN: '1', AUDIT_LOG: '1', INVITE_ONLY: '', ADMIN_UIDS: '', PASSWORD_LOGIN: '',
    SESSION_DAYS: undefined, AUDIT_IP: undefined, HA_INTERNAL_SOCKET: sock, ...env
  };
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
  const h = { dir, data, run, sock, child, log: '' };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  h.port = await boundPort(child, () => h.log);
  h.tcp = (method, p, opts) => call({ host: '127.0.0.1', port: h.port }, method, p, opts);
  h.internal = (method, p, body) => call({ socketPath: sock }, method, p, { body });
  h.haSession = (ha_user_id, name) => h.internal('POST', '/internal/ha-session', { ha_user_id, name });
  // What a browser on the app's own origin sends; upstream's CSRF check passes it.
  h.asUser = (method, p, token, body) => h.tcp(method, p, { body, headers: { Cookie: `gymsid=${token}`, 'Sec-Fetch-Site': 'same-origin' } });
  h.me = token => h.asUser('GET', '/api/me', token);
  h.db = () => JSON.parse(fs.readFileSync(path.join(data, 'db.json'), 'utf8'));
  h.audit = () => { try { return fs.readFileSync(path.join(data, 'audit.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };
  return h;
}

/* A token is upstream's `<uid>:<exp>:<sv>.<HMAC-SHA256(secret, payload), base64url>`, and from
   openGym 1.4.2 `<uid>:<exp>:<sv>:<kind>.<…>`. Checked here with the test's own secret, so
   "upstream's own signing" is asserted, not assumed. */
function decode(token) {
  const i = token.lastIndexOf('.');
  const payload = token.slice(0, i);
  assert.equal(token.slice(i + 1), crypto.createHmac('sha256', SECRET).update(payload).digest('base64url'), 'signed with DATA_DIR/secret');
  const fields = payload.split(':');
  assert.ok(fields.length === 3 || fields.length === 4, `payload ${payload}`);
  const [uid, exp, sv, kind] = fields;
  return { uid, exp: +exp, sv: +sv, kind, fields: fields.length };
}

/* The token upstream itself makes for a browser: the session cookie of its own password sign-up,
   on an instance with PASSWORD_LOGIN on. Every token the internal listener hands out must have that
   shape, the same fields and the same kind, whatever the release: from 1.4.2 a token without its
   kind is read as a paired phone's, which /api/me renews into 90 days and account deletion trusts
   as the device itself. Asked of upstream rather than assumed, so a release that changes it is
   noticed here. */
async function upstreamCookieToken(t) {
  const h = await start(t, { env: { PASSWORD_LOGIN: '1' } });
  const r = await h.tcp('POST', '/api/register/password', {
    body: { name: 'Reference', password: 'a long reference passphrase 7' },
    headers: { 'Sec-Fetch-Site': 'same-origin' }
  });
  assert.equal(r.status, 200, r.text);
  const cookie = [].concat(r.headers['set-cookie'] || []).find(c => c.startsWith('gymsid='));
  assert.ok(cookie, 'upstream sets its session cookie on a password sign-up');
  return decode(cookie.slice('gymsid='.length).split(';')[0]);
}
function assertUpstreamShape(tok, ref) {
  assert.equal(tok.fields, ref.fields, `${tok.fields} fields; upstream's own cookie token has ${ref.fields}`);
  assert.equal(tok.kind, ref.kind, `kind ${tok.kind}; upstream's own cookie token has ${ref.kind}`);
}

/* Filesystem paths of the unix sockets the process has bound: its socket fds, looked up by inode
   in /proc/net/unix (whose last column is the path, present only for a socket bound to one). */
function boundUnixPaths(pid) {
  const inodes = new Set();
  for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
      if (m) inodes.add(m[1]);
    } catch { /* closed while reading */ }
  }
  return fs.readFileSync('/proc/net/unix', 'utf8').split('\n').slice(1)
    .map(l => l.trim().split(/\s+/))
    .filter(c => c.length >= 8 && inodes.has(c[6]))
    .map(c => c[7]);
}

/* Local addresses of every TCP socket in LISTEN state on `port` (/proc/net/tcp and tcp6, hex). */
function listenAddresses(port) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  const out = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length > 3 && c[3] === '0A' && c[1].endsWith(':' + hexPort)) out.push(c[1].split(':')[0]);
    }
  }
  return out;
}

test('the public TCP server gains no route: /internal/* and /api/internal/* answer 404 there', async t => {
  const h = await start(t);
  for (const route of INTERNAL) {
    const [method, p] = route.split(' ');
    for (const target of [p, '/api' + p]) {
      // A body that would succeed on the socket, and the headers upstream's CSRF check wants, so a
      // route registered on this table would answer 200 rather than be refused for another reason.
      const r = await h.tcp(method, target, {
        body: method === 'POST' ? { ha_user_id: 'tcp-probe', name: 'Probe', uid: 'x' } : undefined,
        headers: { 'Sec-Fetch-Site': 'same-origin' }
      });
      assert.equal(r.status, 404, `${method} ${target} over TCP`);
      assert.deepEqual(r.body, { error: 'not found' });
    }
  }
  // Nothing was made by any of that, and the socket does serve the same requests.
  assert.deepEqual((await h.internal('GET', '/internal/users')).body, { users: [] });
  assert.equal((await h.haSession('tcp-probe', 'Probe')).status, 200);
  assert.deepEqual(boundUnixPaths(h.child.pid), [h.sock]);
});

test('with HA_INTERNAL_SOCKET unset no socket is made and the api still serves', async t => {
  const h = await start(t, { env: { HA_INTERNAL_SOCKET: undefined } });
  assert.deepEqual(boundUnixPaths(h.child.pid), [], 'no unix socket bound to any path');
  assert.deepEqual(fs.readdirSync(h.run), []);
  assert.deepEqual(fs.readdirSync(h.data).filter(f => f.endsWith('.sock')), []);
  assert.equal((await h.tcp('GET', '/api/health')).status, 200);
  assert.equal((await h.tcp('GET', '/internal/users')).status, 404);
});

test('ha-session makes a profile tagged with the HA id, and its token is an upstream session for it', async t => {
  // AUDIT_IP=full: audit() would record a socket peer if it found one. There is none on a unix
  // socket, and the row must still be written, with no address and no crash.
  const h = await start(t, { env: { AUDIT_IP: 'full' } });
  const r = await h.haSession('8f2c1e0a9b7d4c3e', 'Alex');
  assert.equal(r.status, 200);
  assert.equal(r.body.created, true);
  assert.deepEqual(Object.keys(r.body.user), ['id', 'name', 'admin', 'disabled']);
  assert.deepEqual(r.body.user, { id: r.body.user.id, name: 'Alex', admin: true, disabled: false });
  assert.match(r.body.user.id, /^[A-Za-z0-9_-]{16}$/, 'randomBytes(12) in base64url, like a passkey sign-up');

  const stored = h.db().users.find(u => u.id === r.body.user.id);
  assert.equal(stored.ha, '8f2c1e0a9b7d4c3e');
  assert.equal(stored.name, 'Alex');
  assert.ok(!Number.isNaN(Date.parse(stored.created)));

  const tok = decode(r.body.token);
  assert.equal(tok.uid, r.body.user.id);
  assert.equal(tok.sv, 0);
  assertUpstreamShape(tok, await upstreamCookieToken(t));
  const me = await h.me(r.body.token);
  assert.equal(me.status, 200);
  // The fields this add-on relies on; upstream adds others over time (1.4.2: owner).
  const { id, name, admin } = me.body.user;
  assert.deepEqual({ id, name, admin }, { id: r.body.user.id, name: 'Alex', admin: true });

  const rows = h.audit().filter(e => e.uid === r.body.user.id);
  const reg = rows.find(e => e.ev === 'auth.register.ok');
  assert.ok(reg, 'the sign-up is audited');
  assert.equal(reg.msg, 'ha-ingress');
  assert.equal('ip' in reg, false);
  assert.ok(rows.some(e => e.ev === 'admin.first-user'));
});

test('a token lives about 60 s and is never renewed as the cookie the gateway sets', async t => {
  const h = await start(t);
  const before = Date.now();
  const r = await h.haSession('ttl-check', 'Timer');
  const after = Date.now();
  const tok = decode(r.body.token);
  assert.ok(tok.exp >= before + 60000 && tok.exp <= after + 60000, `exp ${tok.exp - before} ms after the call`);
  const ref = await upstreamCookieToken(t);
  assertUpstreamShape(tok, ref);

  // GET /api/me renews a Bearer token past half its life, and never a cookie, which is why the
  // gateway injects a cookie and never a Bearer. Up to openGym 1.4.1 every token renews as a
  // Bearer, into a full SESSION_DAYS (90) session, which shows makeSession's default untouched.
  // From 1.4.2 a token made as a cookie (kind `c`) is not renewed as a Bearer either.
  const asCookie = await h.me(r.body.token);
  assert.equal(asCookie.status, 200);
  assert.equal('token' in asCookie.body, false);
  const asBearer = await h.tcp('GET', '/api/me', { headers: { Authorization: `Bearer ${r.body.token}` } });
  assert.equal(asBearer.status, 200);
  if (ref.kind === 'c') {
    assert.equal('token' in asBearer.body, false, 'a cookie-kind token is renewed as a Bearer');
  } else {
    const renewed = decode(asBearer.body.token).exp - Date.now();
    assert.ok(Math.abs(renewed - 90 * 86400000) < 60000, `renewed for ${renewed} ms`);
  }
});

test('the token works as the plain gymsid cookie the gateway sets, with an https ORIGIN too', async t => {
  // With an https ORIGIN (an add-on with external_url set) upstream's own cookie is
  // __Host-gymsid, and it still reads the legacy `gymsid` name, which is what the gateway sends.
  const h = await start(t, { env: { ORIGIN: 'https://gym.example.com' } });
  const r = await h.haSession('https-user', 'Hana');
  assert.equal((await h.me(r.body.token)).body.user.id, r.body.user.id);
  // Upstream refuses two different values under one name, which is why the gateway strips every
  // client gymsid/__Host-gymsid before adding its own: a leftover one would sign the user out.
  const other = (await h.haSession('someone-else', 'Other')).body.token;
  assert.equal((await h.me(other)).status, 200, 'each token works on its own');
  const both = await h.tcp('GET', '/api/me', { headers: { Cookie: `gymsid=${other}; gymsid=${r.body.token}` } });
  assert.equal(both.status, 401);
});

test('a second call for the same HA user finds the same profile and keeps its name', async t => {
  const h = await start(t);
  const first = await h.haSession('same-user', 'Alex');
  const again = await h.haSession('same-user', 'Somebody Else');
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(again.body.user.id, first.body.user.id);
  assert.equal(again.body.user.name, 'Alex', 'the name is used only when the profile is made');
  assert.equal((await h.me(again.body.token)).body.user.id, first.body.user.id);
  assert.equal(h.db().users.length, 1);
});

test('ten concurrent first calls for one HA user make exactly one profile', async t => {
  const h = await start(t);
  // Pipelined (see pipelined()): an await anywhere between finding and saving the profile lets
  // more than one of these make it, every time.
  const raw = await pipelined(h.sock, Array.from({ length: 10 }, (_, i) => ({ ha_user_id: 'burst-user', name: `Name ${i}` })));
  assert.equal((raw.match(/^HTTP\/1\.1 200 /gm) || []).length, 10, raw.slice(0, 400));
  assert.equal((raw.match(/"created":true/g) || []).length, 1);
  assert.equal((raw.match(/"created":false/g) || []).length, 9);
  assert.equal(new Set([...raw.matchAll(/"user":\{"id":"([^"]+)"/g)].map(m => m[1])).size, 1);
  const listed = (await h.internal('GET', '/internal/users')).body.users;
  assert.equal(listed.filter(u => u.ha === 'burst-user').length, 1);
  assert.equal(listed.length, 1);
  assert.equal(h.db().users.length, 1);
});

test('the first profile on the instance is its admin, the second is not', async t => {
  const h = await start(t);
  const a = await h.haSession('first-ha', 'Ana');
  const b = await h.haSession('second-ha', 'Bea');
  assert.equal(a.body.user.admin, true);
  assert.equal(b.body.user.admin, false);
  assert.equal((await h.asUser('GET', '/api/admin/users', a.body.token)).status, 200);
  assert.equal((await h.asUser('GET', '/api/admin/users', b.body.token)).status, 403);
  assert.deepEqual((await h.internal('GET', '/internal/users')).body.users, [
    { id: a.body.user.id, name: 'Ana', admin: true, disabled: false, ha: 'first-ha' },
    { id: b.body.user.id, name: 'Bea', admin: false, disabled: false, ha: 'second-ha' }
  ]);
});

test('/internal/users lists every profile from memory, with ha null for one not made by HA', async t => {
  const h = await start(t, { users: [{ id: 'pk-user', name: 'Passkey Pat', created: new Date().toISOString(), admin: true }] });
  const ha = await h.haSession('ha-one', 'Hal');
  assert.equal(ha.body.user.admin, false, 'not the first profile on this instance');
  assert.deepEqual((await h.internal('GET', '/internal/users')).body.users, [
    { id: 'pk-user', name: 'Passkey Pat', admin: true, disabled: false, ha: null },
    { id: ha.body.user.id, name: 'Hal', admin: false, disabled: false, ha: 'ha-one' }
  ]);
});

test('after sign-out-everywhere the old token is refused and a fresh ha-session token works', async t => {
  const h = await start(t);
  const r = await h.haSession('signout-user', 'Sam');
  assert.equal((await h.me(r.body.token)).status, 200);
  assert.equal((await h.asUser('POST', '/api/logout/all', r.body.token, {})).status, 200);
  assert.equal((await h.me(r.body.token)).status, 401, 'the session version moved on');
  const fresh = await h.haSession('signout-user', 'Sam');
  assert.equal(fresh.body.created, false);
  assert.equal(decode(fresh.body.token).sv, 1);
  const me = await h.me(fresh.body.token);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, r.body.user.id);
});

test('a disabled profile gets disabled true and no token, and is never re-enabled', async t => {
  const h = await start(t);
  const admin = await h.haSession('admin-ha', 'Admin');
  const member = await h.haSession('member-ha', 'Member');
  const id = member.body.user.id;
  const off = await h.asUser('POST', '/api/admin/user/disable', admin.body.token, { id, disabled: true });
  assert.equal(off.status, 200);
  assert.equal(off.body.disabled, true);

  for (let i = 0; i < 2; i++) {
    const r = await h.haSession('member-ha', 'Member');
    assert.equal(r.status, 200);
    assert.equal(r.body.created, false);
    assert.equal(r.body.user.id, id);
    assert.equal(r.body.user.disabled, true);
    assert.equal(r.body.token, null);
  }
  assert.equal(h.db().users.find(u => u.id === id).disabled, true);
  assert.equal((await h.internal('GET', '/internal/users')).body.users.find(u => u.id === id).disabled, true);
  assert.equal((await h.me(member.body.token)).status, 401, 'the token from before the lock is dead too');
  assert.deepEqual((await h.internal('POST', '/internal/session', { uid: id })).body, { error: 'unknown profile' });
});

test('/internal/session: an existing profile gets a working 60 s token; unknown or disabled is 404', async t => {
  const h = await start(t, { users: [
    { id: 'live-user', name: 'Live', created: new Date().toISOString() },
    { id: 'locked-user', name: 'Locked', created: new Date().toISOString(), disabled: true }
  ] });
  const before = Date.now();
  const ok = await h.internal('POST', '/internal/session', { uid: 'live-user' });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body), ['token']);
  const tok = decode(ok.body.token);
  assert.equal(tok.uid, 'live-user');
  assert.ok(tok.exp >= before + 60000 && tok.exp <= Date.now() + 60000);
  assertUpstreamShape(tok, await upstreamCookieToken(t));
  assert.equal((await h.me(ok.body.token)).body.user.id, 'live-user');

  for (const body of [{ uid: 'locked-user' }, { uid: 'nobody' }, { uid: '' }, {}, { uid: { id: 'live-user' } }, { uid: ['live-user'] }]) {
    const r = await h.internal('POST', '/internal/session', body);
    assert.equal(r.status, 404, JSON.stringify(body));
    assert.deepEqual(r.body, { error: 'unknown profile' });
  }
});

test('an invalid ha_user_id is a 400 and matches nobody, not even a profile without an ha id', async t => {
  // An existing profile with no `ha`: without the check, a request with no id would find it
  // (undefined === undefined) and be handed its session.
  const h = await start(t, { users: [{ id: 'existing', name: 'Existing', created: new Date().toISOString(), admin: true }] });
  const bad = [undefined, null, '', ' ', 'a b', 'x'.repeat(129), 'abc/def', '../etc', 'é', 'abc\n', 'a.b', 123, ['abc'], { id: 'abc' }, true];
  for (const id of bad) {
    const body = id === undefined ? { name: 'X' } : { ha_user_id: id, name: 'X' };
    const r = await h.internal('POST', '/internal/ha-session', body);
    assert.equal(r.status, 400, `ha_user_id ${JSON.stringify(id)}`);
    assert.deepEqual(r.body, { error: 'invalid ha_user_id' });
  }
  assert.equal((await h.internal('POST', '/internal/ha-session')).status, 400, 'no body at all');
  assert.equal((await h.internal('POST', '/internal/ha-session', 'not json')).status, 400);
  assert.deepEqual(h.db().users.map(u => u.id), ['existing'], 'nothing was made');
  // The edges of what is allowed.
  for (const id of ['x'.repeat(128), 'A', 'Az09_-']) assert.equal((await h.haSession(id, 'Edge')).status, 200, id);
});

test('the name is trimmed and cut to 40 characters, and an empty one is "Home Assistant user"', async t => {
  const h = await start(t);
  const cases = [
    ['  Alex  ', 'Alex'],
    ['x'.repeat(50), 'x'.repeat(40)],
    ['   ' + 'y'.repeat(45), 'y'.repeat(40)],
    ['', 'Home Assistant user'],
    ['   ', 'Home Assistant user'],
    [undefined, 'Home Assistant user'],
    [null, 'Home Assistant user'],
    [{ toString: 1 }, 'Home Assistant user'],
    [42, '42']
  ];
  for (const [i, [name, want]] of cases.entries()) {
    const r = await h.haSession(`name-${i}`, name);
    assert.equal(r.status, 200, JSON.stringify(name));
    assert.equal(r.body.user.name, want, JSON.stringify(name));
    assert.equal(h.db().users.find(u => u.id === r.body.user.id).name, want);
  }
});

test('INVITE_ONLY=1 does not stop an HA user getting a profile', async t => {
  const h = await start(t, { env: { INVITE_ONLY: '1' } });
  // The instance really is invite-only: a passkey sign-up without a code is refused.
  const signup = await h.tcp('POST', '/api/register/options', { body: { name: 'Walk-in' }, headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(signup.status, 403);
  const r = await h.haSession('invited-by-ha', 'Ivy');
  assert.equal(r.status, 200);
  assert.equal(r.body.created, true);
  assert.equal((await h.me(r.body.token)).status, 200);
  assert.equal(h.db().users[0].invitedBy, undefined, 'no invite was used up');
});

test('the socket file is 0600, and one left behind by a killed server is replaced', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-ha-'));
  const first = await start(t, { dir });
  const st = fs.statSync(first.sock);
  assert.ok(st.isSocket());
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(st.uid, process.getuid());
  const made = await first.haSession('survivor', 'Sur');

  // SIGKILL runs no cleanup, so the socket file stays and a plain listen() would fail EADDRINUSE.
  const gone = new Promise(r => first.child.once('exit', r));
  first.child.kill('SIGKILL');
  await gone;
  assert.ok(fs.statSync(first.sock).isSocket(), 'the stale socket is still there');

  const second = await start(t, { dir });
  assert.equal(fs.statSync(second.sock).mode & 0o777, 0o600);
  const again = await second.haSession('survivor', 'Sur');
  assert.equal(again.body.created, false);
  assert.equal(again.body.user.id, made.body.user.id);
});

test('something other than a socket at HA_INTERNAL_SOCKET is not deleted: the server refuses to start', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-ha-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'run'), { mode: 0o700 });
  const victim = path.join(dir, 'run', 'internal.sock');
  fs.writeFileSync(victim, 'not a socket');
  await assert.rejects(start(t, { dir }), /server exited/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'not a socket');
});

test('HOST=127.0.0.1 binds the public listener to loopback only; unset, it is every interface', async t => {
  const loop = await start(t);
  assert.deepEqual(listenAddresses(loop.port), ['0100007F'], '127.0.0.1 in /proc/net/tcp');
  // The control: without HOST the bind is node's default, the unspecified address (:: where the
  // host has IPv6, 0.0.0.0 where it does not).
  const any = await start(t, { env: { HOST: undefined } });
  const addrs = listenAddresses(any.port);
  assert.equal(addrs.length, 1);
  assert.match(addrs[0], /^0+$/);
});

test('unknown internal routes and methods are 404, and a body over upstream\'s cap is its 413', async t => {
  const h = await start(t);
  assert.equal((await h.internal('GET', '/internal/ha-session')).status, 404);
  assert.equal((await h.internal('POST', '/internal/users', {})).status, 404);
  assert.equal((await h.internal('GET', '/api/health')).status, 404, 'the socket serves only its own table');
  assert.equal((await h.internal('GET', '/internal/users?x=1')).status, 200);
  const big = await h.internal('POST', '/internal/ha-session', JSON.stringify({ ha_user_id: 'big', name: 'x'.repeat(6 * 1024 * 1024) }));
  assert.equal(big.status, 413);
  assert.deepEqual(big.body, { error: 'body too large' });
});
