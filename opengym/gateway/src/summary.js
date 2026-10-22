// GET /ha/v1/summary: what HA shows per profile, derived from the state documents on disk.
//
// Read from disk (state-<uid>.json, read-only), never through GET /api/data: that route records
// a pull on the user (notePull), so HA polling every minute would make the admin dashboard show
// every profile as "synced" when nobody opened the app. Any value that cannot be derived is
// null — never a guess.
import fs from 'node:fs/promises';
import path from 'node:path';
import { profileUnit } from './units.js';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UNREADABLE = Symbol('unreadable');

const isRecord = x => !!x && typeof x === 'object' && !Array.isArray(x);
const records = v => (Array.isArray(v) ? v.filter(isRecord) : []);
const finiteTime = v => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const validDate = ms => ms !== null && !Number.isNaN(new Date(ms).getTime());
const isoTime = ms => (validDate(ms) ? new Date(ms).toISOString() : null);

/** A time zone Intl accepts, or null. */
export function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return null;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return tz; } catch { return null; }
}

/** The profile's zone: its reminder zone (what upstream's reminders fire by), else TZ, else UTC. */
export function profileTimeZone(S, envTz) {
  return validTimeZone(S?.reminder?.tz) || validTimeZone(envTz) || 'UTC';
}

/** The calendar date of an instant in `tz` (upstream queue.js dayIn). */
export function dayIn(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const get = t => parts.find(p => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** A real calendar date in YYYY-MM-DD form. */
export function isCalendarDay(s) {
  if (typeof s !== 'string' || !ISO_DAY.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === s;
}

// Plain calendar arithmetic, done in UTC so neither the container's zone nor DST can move a day.
const utcOf = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
export const addDays = (iso, n) => new Date(utcOf(iso) + n * 86_400_000).toISOString().slice(0, 10);

/** Upstream format.js weekStartOf: only 0 means Sunday; anything else (or nothing) is Monday. */
export const weekStartOf = S => (S?.weekStart === 0 ? 0 : 1);
/** Upstream format.js weekKey: the date the week holding `iso` starts on. */
export function weekKey(iso, ws) {
  const dow = new Date(utcOf(iso)).getUTCDay();
  return addDays(iso, -((dow - ws + 7) % 7));
}

/** Upstream history.js workoutDay: its stored local date `d`, else the date of its start. */
export function workoutDay(w, tz) {
  if (isCalendarDay(w.d)) return w.d;
  const start = finiteTime(w.start);
  return validDate(start) ? dayIn(start, tz) : null;
}

function latestWeighIn(S) {
  let best = null;
  for (const e of records(S.bodyweight)) {
    const w = Number(e.w);
    if (!isCalendarDay(e.d) || !(w > 0) || !Number.isFinite(w)) continue;
    const t = finiteTime(e.t) ?? 0;
    if (!best || e.d > best.d || (e.d === best.d && t > best.t)) best = { d: e.d, w, t, rawT: finiteTime(e.t) };
  }
  if (!best) return null;
  return { value: best.w, unit: profileUnit(S), date: best.d, measured_at: best.rawT ? isoTime(best.rawT) : null };
}

function routineNameOf(S, id) {
  const r = records(S.routines).find(x => x.id === id);
  return r && typeof r.name === 'string' ? r.name : null;
}

function lastWorkout(S, list) {
  let best = null;
  for (const item of list) {
    const when = finiteTime(item.w.end) ?? finiteTime(item.w.start) ?? 0;
    if (!best || item.day > best.day || (item.day === best.day && when > best.when)) best = { ...item, when };
  }
  if (!best) return null;
  const { w, day } = best;
  const start = finiteTime(w.start);
  const end = finiteTime(w.end);
  // The workout's own title is what History shows (a merged session reads "Push + Pull"); a
  // workout without one falls back to the routine it was started from.
  const ids = Array.isArray(w.routineIds) ? w.routineIds : (w.routineId ? [w.routineId] : []);
  const name = typeof w.name === 'string' && w.name.trim() ? w.name : (ids.length ? routineNameOf(S, ids[0]) : null);
  return {
    id: typeof w.id === 'string' || typeof w.id === 'number' ? String(w.id) : null,
    date: day,
    started_at: isoTime(start),
    ended_at: isoTime(end),
    routine_name: name,
    // Upstream coach-insights: whole minutes between start and end, null when either is missing.
    duration_min: start !== null && end !== null ? Math.round(Math.max(0, end - start) / 60_000) : null,
  };
}

function safely(fn) {
  try { return fn(); } catch { return null; }
}

/**
 * One profile's summary from its document `S` (null = no state file, UNREADABLE = a file that
 * does not parse). `now` is ms since the epoch.
 */
export function summarizeProfile(user, S, { now, envTz, effectiveRoutineId }) {
  const head = { id: user.id, name: typeof user.name === 'string' ? user.name : null, admin: user.admin === true };
  if (S === UNREADABLE) {
    return { ...head, unit: null, body_weight: null, last_workout: null, workouts_this_week: null, workouts_7d: null, today: null, rev: null };
  }
  const tz = profileTimeZone(S, envTz);
  const today = dayIn(now, tz);
  if (S === null) {
    return {
      ...head, unit: 'kg', body_weight: null, last_workout: null, workouts_this_week: 0, workouts_7d: 0,
      today: { date: today, routine_id: null, routine_name: null, rest_day: true }, rev: 0,
    };
  }
  // A document on disk "answers to nobody" (upstream's words): every derivation is guarded on
  // its own, so one malformed list nulls one field instead of failing the whole summary.
  const dated = safely(() => records(S.workouts).map(w => ({ w, day: workoutDay(w, tz) })).filter(x => x.day));
  const ws = weekStartOf(S);
  const thisWeek = weekKey(today, ws);
  const weekAgo = addDays(today, -6);
  const todayPlan = safely(() => {
    const id = effectiveRoutineId(S, today);
    return { date: today, routine_id: id ?? null, routine_name: id ? routineNameOf(S, id) : null, rest_day: !id };
  });
  return {
    ...head,
    unit: profileUnit(S),
    body_weight: safely(() => latestWeighIn(S)),
    last_workout: dated && safely(() => lastWorkout(S, dated)),
    workouts_this_week: dated && dated.filter(x => weekKey(x.day, ws) === thisWeek).length,
    workouts_7d: dated && dated.filter(x => x.day >= weekAgo && x.day <= today).length,
    today: todayPlan,
    rev: Number.isInteger(S._rev) ? S._rev : 0,
  };
}

/** Upstream server.js stateFile: the same sanitising, so this reads the file upstream writes. */
export const stateFileOf = (dataDir, uid) => path.join(dataDir, 'state-' + String(uid).replace(/[^a-zA-Z0-9_-]/g, '') + '.json');

/**
 * Reader of state documents with a cache keyed on (inode, mtime, size). Upstream writes every
 * state file by temp-file + rename, so each write is a new inode: even two writes inside one
 * mtime tick with the same size are told apart (upstream's own stat cache needed an explicit
 * eviction for exactly that case, which a reader in another process cannot do).
 */
export function createStateReader(dataDir) {
  const cache = new Map(); // uid -> { key, doc }
  async function read(uid) {
    let fh;
    try { fh = await fs.open(stateFileOf(dataDir, uid), 'r'); } catch (e) {
      cache.delete(uid);
      return e.code === 'ENOENT' ? null : UNREADABLE;
    }
    try {
      // fstat of the open file, so the key and the bytes read are the same file.
      const st = await fh.stat();
      const key = `${st.ino}:${st.mtimeMs}:${st.size}`;
      const hit = cache.get(uid);
      if (hit && hit.key === key) return hit.doc;
      let doc;
      try { doc = JSON.parse(await fh.readFile('utf8')); } catch { doc = UNREADABLE; }
      if (doc !== UNREADABLE && !isRecord(doc)) doc = UNREADABLE;
      cache.set(uid, { key, doc });
      return doc;
    } finally {
      await fh.close();
    }
  }
  /** Drop cache entries of profiles that no longer exist. */
  function retain(uids) {
    const keep = new Set(uids);
    for (const uid of cache.keys()) if (!keep.has(uid)) cache.delete(uid);
  }
  return { read, retain, cacheSize: () => cache.size };
}

/** The full /ha/v1/summary body for `users` (from GET /internal/users). */
export async function buildSummary(users, { reader, now = Date.now(), envTz, effectiveRoutineId }) {
  const live = users.filter(u => !u.disabled);
  reader.retain(live.map(u => u.id));
  const profiles = [];
  for (const user of live) {
    const S = await reader.read(user.id);
    profiles.push(summarizeProfile(user, S, { now, envTz, effectiveRoutineId }));
  }
  return { generated_at: new Date(now).toISOString(), profiles };
}

export { UNREADABLE };
