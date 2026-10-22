// POST /ha/v1/profiles/{id}/bodyweight against a fake internal socket and a fake api that
// implements upstream's revision rules (baseRev / baseWid -> 409 with the current document).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyWeighIn, entryStamp, NO_DATA, validateInput } from '../src/bodyweight.js';
import { alex, NOW, sam } from './fixtures/states.js';
import { json, request, startFakeApi, startFakeInternal, startGateway, TOKEN } from './helpers/servers.js';

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });
const track = x => { cleanups.push(x.close); return x; };
const clone = x => JSON.parse(JSON.stringify(x));

/**
 * A fake api holding one document per uid. PUT follows upstream server.js: a baseRev that is not
 * the current revision, or a baseWid that is not the stored _wid, is a 409 carrying the current
 * document; otherwise the document is stored with rev + 1 and a new _wid.
 * `interfere(n)` runs before the n-th PUT is judged (another device writing in between).
 */
async function fakeApiWith(docs, { interfere = () => {} } = {}) {
  const store = new Map(Object.entries(docs).map(([k, v]) => [k, v === null ? null : clone(v)]));
  let puts = 0;
  const uidOf = req => /^Bearer tok-(.+)$/.exec(req.headers.authorization || '')?.[1];
  const api = track(await startFakeApi({
    'GET /api/data': async req => {
      const uid = uidOf(req);
      if (!store.has(uid)) return [401, { error: 'not signed in' }];
      const S = store.get(uid);
      return [200, { state: S, rev: S?._rev || 0 }];
    },
    'PUT /api/data': async (req, body) => {
      const uid = uidOf(req);
      if (!store.has(uid)) return [401, { error: 'not signed in' }];
      puts += 1;
      interfere(puts, store, uid);
      const cur = store.get(uid);
      const curRev = cur?._rev || 0;
      if ((body.baseRev != null && body.baseRev !== curRev) || (body.baseRev != null && typeof body.baseWid === 'string' && cur?._wid && body.baseWid !== cur._wid)) {
        return [409, { error: 'conflict', rev: curRev, state: cur }];
      }
      const next = { ...body.state, _rev: curRev + 1, _wid: `wid-${curRev + 1}` };
      store.set(uid, next);
      return [200, { ok: true, ts: null, rev: curRev + 1, wid: next._wid }];
    },
  }));
  return { api, store, putCount: () => puts };
}

async function setup(docs, opts = {}) {
  const fake = await fakeApiWith(docs, opts);
  const internal = track(await startFakeInternal({
    'POST /internal/session': async body => (Object.hasOwn(docs, body.uid) ? [200, { token: `tok-${body.uid}` }] : [404, { error: 'unknown profile' }]),
  }));
  const gw = track(await startGateway({ socketPath: internal.socketPath, now: opts.now || (() => NOW), config: { apiUrl: fake.api.url, envTz: opts.envTz || '' } }));
  const post = (id, body) => request(gw.url, { method: 'POST', path: `/ha/v1/profiles/${id}/bodyweight`, headers: [['Authorization', `Bearer ${TOKEN}`], ['Content-Type', 'application/json']], body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { ...fake, internal, gw, post };
}

test('kg weigh-in into an lb profile: converted with upstream\'s rule, inserted, list sorted, baseRev + baseWid sent', async () => {
  const { post, store, api } = await setup({ sam });
  const r = await post('sam', { weight: 80.2, unit: 'kg', date: '2026-10-20' });
  assert.equal(r.status, 200);
  assert.deepEqual(json(r), { profile_id: 'sam', entry: { date: '2026-10-20', value: 176.8, unit: 'lb' }, rev: 8 });
  const put = api.calls.find(c => c.key === 'PUT /api/data');
  assert.equal(put.body.baseRev, 7);
  assert.equal(put.body.baseWid, 'ffeeddccbbaa9988');
  assert.equal('stamped' in put.body, false, 'no stamped flag: upstream stamps for an API writer');
  assert.equal(put.headers.authorization, 'Bearer tok-sam');
  const days = store.get('sam').bodyweight.map(e => e.d);
  assert.deepEqual(days, [...days].sort(), 'sorted by day');
  const added = store.get('sam').bodyweight.find(e => e.d === '2026-10-20');
  assert.deepEqual(added, { d: '2026-10-20', w: 176.8, t: NOW });
  // Everything else in the document is what the api sent back.
  assert.deepEqual(store.get('sam').workouts, sam.workouts);
  assert.equal(store.get('sam').bodyweight.length, sam.bodyweight.length + 1);
});

test('same-day weigh-in updates that entry in place; t beats the old t', async () => {
  const doc = clone(alex);
  doc.bodyweight[0].t = NOW + 60_000; // stamped "in the future" by a device with a fast clock
  const { post, store } = await setup({ alex: doc });
  const r = await post('alex', { weight: 79.84, unit: 'kg', date: '2026-10-21' });
  assert.equal(r.status, 200);
  assert.deepEqual(json(r).entry, { date: '2026-10-21', value: 79.8, unit: 'kg' });
  const list = store.get('alex').bodyweight;
  assert.equal(list.length, alex.bodyweight.length, 'no second entry for the day');
  const e = list.find(x => x.d === '2026-10-21');
  assert.equal(e.w, 79.8);
  assert.equal(e.t, NOW + 60_001);
});

test('the t rule: max(now, old.t + 1, |deleted.bodyweight[d]| + 1, resetAt + 1)', () => {
  const now = 1_000;
  assert.equal(entryStamp({}, '2026-10-21', null, now), 1_000);
  assert.equal(entryStamp({}, '2026-10-21', { t: 5_000 }, now), 5_001);
  assert.equal(entryStamp({ deleted: { bodyweight: { '2026-10-21': 7_000 } } }, '2026-10-21', null, now), 7_001);
  assert.equal(entryStamp({ deleted: { bodyweight: { '2026-10-21': -8_000 } } }, '2026-10-21', null, now), 8_001, 'a negative (re-added) stamp counts by magnitude');
  assert.equal(entryStamp({ deleted: { bodyweight: { '2026-10-20': 9_000 } } }, '2026-10-21', null, now), 1_000, 'another day\'s removal does not count');
  assert.equal(entryStamp({ resetAt: 9_500 }, '2026-10-21', { t: 2 }, now), 9_501);
});

test('a day removed on another device gets a stamp later than the removal (else upstream would re-flag it)', async () => {
  const doc = { ...clone(alex), deleted: { bodyweight: { '2026-10-22': NOW + 5_000 } } };
  const { post, store } = await setup({ alex: doc });
  assert.equal((await post('alex', { weight: 80, unit: 'kg', date: '2026-10-22' })).status, 200);
  assert.equal(store.get('alex').bodyweight.find(e => e.d === '2026-10-22').t, NOW + 5_001);
});

test('date defaults to today in the profile\'s zone; measured_at dates the weigh-in when no date is given', async () => {
  const { post, store } = await setup({ alex, sam }, { envTz: 'America/New_York' });
  // Alex's reminder zone is Auckland: Friday the 23rd there.
  assert.equal(json(await post('alex', { weight: 80, unit: 'kg' })).entry.date, '2026-10-23');
  // Sam has none: the container TZ, New York, Thursday the 22nd.
  assert.equal(json(await post('sam', { weight: 170, unit: 'lb' })).entry.date, '2026-10-22');
  // 03:00 UTC on the 22nd is the 21st in New York.
  assert.equal(json(await post('sam', { weight: 171, unit: 'lb', measured_at: '2026-10-22T03:00:00Z' })).entry.date, '2026-10-21');
  assert.ok(store.get('alex').bodyweight.some(e => e.d === '2026-10-23' && e.w === 80));
});

test('409: re-applied onto the state in the 409 body (its _wid), and the other device\'s write survives', async () => {
  const interfere = (n, store, uid) => {
    if (n !== 1) return;
    // Another device logs a weigh-in between our GET and our PUT.
    const S = store.get(uid);
    store.set(uid, { ...S, bodyweight: [...S.bodyweight, { d: '2026-10-22', w: 81, t: NOW - 10 }], _rev: S._rev + 1, _wid: 'other-device' });
  };
  const { post, store, api, putCount } = await setup({ alex }, { interfere });
  const r = await post('alex', { weight: 80.5, unit: 'kg', date: '2026-10-22' });
  assert.equal(r.status, 200);
  assert.equal(putCount(), 2);
  const puts = api.calls.filter(c => c.key === 'PUT /api/data');
  assert.equal(puts[1].body.baseRev, 43);
  assert.equal(puts[1].body.baseWid, 'other-device');
  assert.equal(api.calls.filter(c => c.key === 'GET /api/data').length, 1, 'no second GET: the 409 carries the document');
  const day = store.get('alex').bodyweight.filter(e => e.d === '2026-10-22');
  assert.deepEqual(day, [{ d: '2026-10-22', w: 80.5, t: NOW }], 'our value for the day, its t beating the other device\'s');
  assert.equal(json(r).rev, 44);
});

test('409 three times in a row -> the curated conflict error', async () => {
  const interfere = (n, store, uid) => { const S = store.get(uid); store.set(uid, { ...S, _rev: S._rev + 1, _wid: `busy-${n}` }); };
  const { post, putCount } = await setup({ alex }, { interfere });
  const r = await post('alex', { weight: 80, unit: 'kg', date: '2026-10-22' });
  assert.equal(r.status, 409);
  assert.deepEqual(json(r), { error: 'the profile changed while saving, try again' });
  assert.equal(putCount(), 3);
});

test('a profile with no state yet -> the no-data 409, and nothing is PUT', async () => {
  const { post, api } = await setup({ fresh: null });
  const r = await post('fresh', { weight: 80, unit: 'kg' });
  assert.equal(r.status, 409);
  assert.deepEqual(json(r), NO_DATA);
  assert.equal(api.calls.filter(c => c.key === 'PUT /api/data').length, 0, 'never a skeleton document');
});

test('unknown profile -> 404; api down -> 502; both curated', async () => {
  const { post } = await setup({ alex });
  const r = await post('nobody', { weight: 80, unit: 'kg' });
  assert.equal(r.status, 404);
  assert.deepEqual(json(r), { error: 'unknown profile' });

  const internal = track(await startFakeInternal({ 'POST /internal/session': async () => [200, { token: 'tok-x' }] }));
  const gw = track(await startGateway({ socketPath: internal.socketPath, config: { apiUrl: 'http://127.0.0.1:9' } }));
  const down = await request(gw.url, { method: 'POST', path: '/ha/v1/profiles/x/bodyweight', headers: [['Authorization', `Bearer ${TOKEN}`]], body: '{"weight":80,"unit":"kg"}' });
  assert.equal(down.status, 502);
  assert.deepEqual(json(down), { error: 'openGym is not responding' });
});

test('400 on invalid input, before anything is read or written', async () => {
  const { post, api, internal } = await setup({ alex });
  for (const body of [
    '{nope', '[]', '"x"', {}, { weight: 80 }, { weight: 80, unit: 'stone' }, { weight: '80', unit: 'kg' },
    { weight: 0, unit: 'kg' }, { weight: -1, unit: 'kg' }, { weight: 700.1, unit: 'kg' }, { weight: 1544, unit: 'lb' },
    { weight: 80, unit: 'kg', date: '2026-02-30' }, { weight: 80, unit: 'kg', date: '22.10.2026' },
    { weight: 80, unit: 'kg', measured_at: 'yesterday' }, { weight: 80, unit: 'kg', measured_at: 5 },
    { weight: 0.04, unit: 'kg' },
  ]) {
    const r = await post('alex', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(typeof json(r).error, 'string');
  }
  assert.equal(api.calls.filter(c => c.key === 'PUT /api/data').length, 0);
  assert.ok(internal.calls.length <= 1, 'only the too-small case got as far as minting a session');
  // The limits themselves are accepted.
  assert.equal(validateInput({ weight: 700, unit: 'kg' }).error, undefined);
  assert.equal(validateInput({ weight: 1543.2, unit: 'lb' }).error, undefined);
});

test('applyWeighIn leaves the input document untouched and keeps other days and fields', () => {
  const before = clone(alex);
  const { state, entry } = applyWeighIn(alex, { weight: 176.8, unit: 'lb', date: '2026-10-05', now: NOW });
  assert.deepEqual(alex, before, 'input not mutated');
  assert.deepEqual(entry, { date: '2026-10-05', value: 80.2, unit: 'kg' });
  assert.deepEqual(state.bodyweight.map(e => e.d), ['2026-10-01', '2026-10-05', '2026-10-20', '2026-10-21']);
  assert.equal(state.workouts, alex.workouts);
});
