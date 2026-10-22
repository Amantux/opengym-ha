import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSummary, createStateReader, dayIn, profileTimeZone, stateFileOf, summarizeProfile, weekKey, weekStartOf } from '../src/summary.js';
import { alex, NOW, sam } from './fixtures/states.js';
import { haSessionStore, json, request, startFakeApi, startFakeInternal, startGateway, tmpDir, TOKEN } from './helpers/servers.js';

// Upstream's own rule, from the same place production imports it (UPSTREAM_API_DIR=/app in the
// image; in a source checkout, point it at <upstream>/api).
const UPSTREAM_API_DIR = process.env.UPSTREAM_API_DIR || '/app';
const { effectiveRoutineId } = await import(pathToFileURL(path.join(UPSTREAM_API_DIR, 'queue.js')).href);

const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });
const track = x => { cleanups.push(x.close); return x; };

const users = [
  { id: 'alex', name: 'Alex', admin: true, disabled: false, ha: 'h1' },
  { id: 'sam', name: 'Sam', admin: false, disabled: false, ha: 'h2' },
  { id: 'fresh', name: 'Fresh', admin: false, disabled: false, ha: 'h3' },
  { id: 'gone', name: 'Gone', admin: false, disabled: true, ha: 'h4' },
];

function dataDirWith(docs) {
  const dir = tmpDir('gw-state-');
  for (const [uid, doc] of Object.entries(docs)) fs.writeFileSync(stateFileOf(dir, uid), typeof doc === 'string' ? doc : JSON.stringify(doc));
  return dir;
}

test('summary from fixtures: time zones, week start, today via upstream effectiveRoutineId, latest weigh-in', async () => {
  const dir = dataDirWith({ alex, sam, gone: alex });
  const out = await buildSummary(users, { reader: createStateReader(dir), now: NOW, envTz: 'America/New_York', effectiveRoutineId });
  assert.equal(out.generated_at, '2026-10-22T12:30:00.000Z');
  assert.deepEqual(out.profiles.map(p => p.id), ['alex', 'sam', 'fresh'], 'disabled profiles left out');
  const [a, s, f] = out.profiles;

  // Alex: reminder zone Pacific/Auckland -> Friday 2026-10-23, Monday-first week.
  assert.deepEqual(a, {
    id: 'alex', name: 'Alex', admin: true, unit: 'kg',
    body_weight: { value: 80.2, unit: 'kg', date: '2026-10-21', measured_at: '2026-10-20T17:30:00.000Z' },
    last_workout: { id: 'w6', date: '2026-10-21', started_at: '2026-10-21T05:00:00.000Z', ended_at: '2026-10-21T05:52:00.000Z', routine_name: 'Push A', duration_min: 52 },
    workouts_this_week: 3,   // Mon 19, Wed 21 (x2); Sunday 18 belongs to the week before
    workouts_7d: 5,          // 17..23: w2 w3 w4 w5 w6
    today: { date: '2026-10-23', routine_id: 'r2', routine_name: 'Pull B', rest_day: false },  // Friday plan
    rev: 42,
  });

  // Sam: no reminder zone -> the container TZ (New York, Thursday 22nd); Sunday-first week;
  // floating queue: Day A done on the 18th, so today is Day B rather than Thursday's "Upper".
  assert.equal(s.unit, 'lb');
  assert.deepEqual(s.body_weight, { value: 177, unit: 'lb', date: '2026-10-22', measured_at: '2026-10-22T11:05:00.000Z' });
  assert.deepEqual(s.today, { date: '2026-10-22', routine_id: 'q2', routine_name: 'Day B', rest_day: false });
  assert.equal(s.workouts_this_week, 1, 'Sunday 18th starts the week; the start-dated workout is Saturday 17th local');
  assert.equal(s.workouts_7d, 2, '16..22 holds both');
  assert.equal(s.last_workout.id, 's1');
  assert.equal(s.last_workout.duration_min, 70);
  assert.equal(s.rev, 7);

  // No state file at all.
  assert.deepEqual(f, {
    id: 'fresh', name: 'Fresh', admin: false, unit: 'kg', body_weight: null, last_workout: null,
    workouts_this_week: 0, workouts_7d: 0,
    today: { date: '2026-10-22', routine_id: null, routine_name: null, rest_day: true }, rev: 0,
  });
});

test('the same profile without its reminder zone is read in TZ, then UTC', async () => {
  const noTz = { ...alex, reminder: { ...alex.reminder, tz: null } };
  const inUtc = summarizeProfile(users[0], noTz, { now: NOW, envTz: '', effectiveRoutineId });
  assert.equal(inUtc.today.date, '2026-10-22', 'UTC: still Thursday');
  assert.equal(inUtc.today.rest_day, true, 'nothing planned on Thursdays');
  const inTz = summarizeProfile(users[0], noTz, { now: NOW, envTz: 'Asia/Tokyo', effectiveRoutineId });
  assert.equal(inTz.today.date, '2026-10-22', 'Tokyo: 21:30 Thursday');
  const late = summarizeProfile(users[0], noTz, { now: Date.parse('2026-10-22T16:00:00Z'), envTz: 'Asia/Tokyo', effectiveRoutineId });
  assert.equal(late.today.date, '2026-10-23', 'Tokyo after midnight: Friday');
  assert.equal(late.today.routine_name, 'Pull B');
});

test('time zone chain: reminder.tz -> TZ -> UTC, invalid zones skipped', () => {
  assert.equal(profileTimeZone({ reminder: { tz: 'Europe/Zurich' } }, 'Asia/Tokyo'), 'Europe/Zurich');
  assert.equal(profileTimeZone({ reminder: { tz: 'Not/AZone' } }, 'Asia/Tokyo'), 'Asia/Tokyo');
  assert.equal(profileTimeZone({ reminder: { tz: null } }, 'Asia/Tokyo'), 'Asia/Tokyo');
  assert.equal(profileTimeZone(null, 'Asia/Tokyo'), 'Asia/Tokyo');
  assert.equal(profileTimeZone({}, 'Bogus/Zone'), 'UTC');
  assert.equal(profileTimeZone({}, ''), 'UTC');
  assert.equal(dayIn(NOW, 'Pacific/Auckland'), '2026-10-23');
  assert.equal(dayIn(NOW, 'UTC'), '2026-10-22');
});

test('week start follows upstream: only weekStart 0 is Sunday', () => {
  assert.equal(weekStartOf({}), 1);
  assert.equal(weekStartOf({ weekStart: 0 }), 0);
  assert.equal(weekStartOf({ weekStart: 3 }), 1);
  assert.equal(weekStartOf({ weekStart: null }), 1);
  // Upstream week-start.test.js: Wednesday 2026-08-19.
  assert.equal(weekKey('2026-08-19', 1), '2026-08-17');
  assert.equal(weekKey('2026-08-19', 0), '2026-08-16');
  assert.equal(weekKey('2026-08-17', 1), '2026-08-17');
  assert.equal(weekKey('2026-03-29', 1), '2026-03-23', 'DST Sunday stays in its own week');
  const sundayFirst = summarizeProfile(users[0], { ...alex, weekStart: 0 }, { now: NOW, envTz: '', effectiveRoutineId });
  assert.equal(sundayFirst.workouts_this_week, 4, 'Sun 18 .. Sat 24 now includes Sunday');
});

test('a rest-day override and a malformed list null only their own field', () => {
  const rest = summarizeProfile(users[0], { ...alex, dayPlan: { '2026-10-23': 'rest' } }, { now: NOW, envTz: '', effectiveRoutineId });
  assert.deepEqual(rest.today, { date: '2026-10-23', routine_id: null, routine_name: null, rest_day: true });
  const broken = summarizeProfile(users[0], { ...alex, routines: { not: 'a list' }, queue: { ids: ['r1'] } }, { now: NOW, envTz: '', effectiveRoutineId });
  assert.equal(broken.today, null, 'effectiveRoutineId threw on the malformed document');
  assert.equal(broken.workouts_7d, 5, 'the rest of the summary still derives');
  assert.equal(broken.body_weight.value, 80.2);
});

test('an unreadable state file: every derived field null, nothing invented', async () => {
  const dir = dataDirWith({ alex: '{ not json' });
  const out = await buildSummary([users[0]], { reader: createStateReader(dir), now: NOW, envTz: '', effectiveRoutineId });
  assert.deepEqual(out.profiles[0], {
    id: 'alex', name: 'Alex', admin: true, unit: null, body_weight: null, last_workout: null,
    workouts_this_week: null, workouts_7d: null, today: null, rev: null,
  });
});

test('state reader: cached on (inode, mtime, size); an atomic rewrite with the same mtime and size is still seen', async () => {
  const dir = dataDirWith({ alex: { ...alex, _rev: 41 } });
  const file = stateFileOf(dir, 'alex');
  const T = 1_790_000_000; // whole seconds, so utimes reproduces the mtime exactly
  fs.utimesSync(file, T, T);
  const reader = createStateReader(dir);
  const first = await reader.read('alex');
  assert.equal(first._rev, 41);
  assert.equal(await reader.read('alex'), first, 'unchanged file -> the cached object');
  const before = fs.statSync(file);
  // Upstream writes temp + rename; make the new file indistinguishable by mtime and size.
  fs.writeFileSync(file + '.tmp', JSON.stringify({ ...alex, _rev: 49 }));
  fs.renameSync(file + '.tmp', file);
  fs.utimesSync(file, T, T);
  const now = fs.statSync(file);
  assert.equal(now.size, before.size);
  assert.equal(now.mtimeMs, before.mtimeMs);
  assert.notEqual(now.ino, before.ino);
  assert.equal((await reader.read('alex'))._rev, 49);
  fs.unlinkSync(file);
  assert.equal(await reader.read('alex'), null, 'deleted -> no state');
  reader.retain([]);
  assert.equal(reader.cacheSize(), 0);
});

test('state file names are sanitised exactly like upstream stateFile()', () => {
  assert.equal(stateFileOf('/d', 'aB9_-x'), path.join('/d', 'state-aB9_-x.json'));
  assert.equal(stateFileOf('/d', '../../etc/passwd'), path.join('/d', 'state-etcpasswd.json'));
});

test('GET /ha/v1/summary reads from disk and never calls GET /api/data', async () => {
  const dir = dataDirWith({ alex });
  const store = haSessionStore();
  store.users.push(users[0]);
  const internal = track(await startFakeInternal({ 'GET /internal/users': async () => [200, { users: store.users }] }));
  const api = track(await startFakeApi({ 'GET /api/data': async () => [200, { state: null, rev: 0 }] }));
  const gw = track(await startGateway({ socketPath: internal.socketPath, effectiveRoutineId, now: () => NOW, config: { dataDir: dir, apiUrl: api.url } }));
  const r = await request(gw.url, { path: '/ha/v1/summary', headers: [['Authorization', `Bearer ${TOKEN}`]] });
  assert.equal(r.status, 200);
  const body = json(r);
  assert.equal(body.profiles[0].last_workout.id, 'w6');
  assert.equal(body.profiles[0].today.routine_name, 'Pull B');
  assert.equal(api.calls.length, 0, 'no api call at all, GET /api/data least of all');
});
