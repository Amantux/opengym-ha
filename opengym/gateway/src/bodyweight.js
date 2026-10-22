// POST /ha/v1/profiles/{id}/bodyweight — a weigh-in from HA (a smart scale automation) written
// into the profile through upstream's own sync route, as that profile, with its optimistic
// concurrency (baseRev + baseWid). The write is a normal app-level edit, never a skeleton
// document: a profile with no state yet is refused rather than created here.
import { ApiUnavailable, callApi } from './api.js';
import { InternalUnavailable } from './internal.js';
import { dayIn, isCalendarDay, profileTimeZone } from './summary.js';
import { LB_PER_KG, profileUnit, toStoredBodyWeight } from './units.js';

const MAX_KG = 700;
const ATTEMPTS = 3;

export const NO_DATA = { error: 'This profile has no data yet. Log something in openGym as that person (a workout, a weigh-in or any setting), then try again.' };
export const CONFLICT = { error: 'the profile changed while saving, try again' };
export const UNKNOWN_PROFILE = { error: 'unknown profile' };
export const NOT_RESPONDING = { error: 'openGym is not responding' };

/** -> { input } or { error } (a curated message for the 400). */
export function validateInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'expected a JSON object' };
  const { weight, unit, date, measured_at: measuredAt } = body;
  if (unit !== 'kg' && unit !== 'lb') return { error: 'unit must be "kg" or "lb"' };
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) return { error: 'weight must be a number greater than 0' };
  if ((unit === 'lb' ? weight / LB_PER_KG : weight) > MAX_KG) return { error: `weight must be at most ${MAX_KG} kg` };
  if (date !== undefined && date !== null && !isCalendarDay(date)) return { error: 'date must be a calendar date in YYYY-MM-DD form' };
  let measuredMs = null;
  if (measuredAt !== undefined && measuredAt !== null) {
    measuredMs = typeof measuredAt === 'string' ? Date.parse(measuredAt) : NaN;
    if (!Number.isFinite(measuredMs)) return { error: 'measured_at must be an ISO 8601 date and time' };
  }
  return { input: { weight, unit, date: date ?? null, measuredMs } };
}

/** `t` for the entry: later than everything a merge or a removal could compare it against. */
export function entryStamp(S, date, old, now) {
  const removedAt = Math.abs(Number(S.deleted?.bodyweight?.[date]) || 0);
  return Math.max(now, (Number(old?.t) || 0) + 1, removedAt + 1, (Number(S.resetAt) || 0) + 1);
}

/**
 * A copy of `S` with the weigh-in applied the way the app's own weigh-in sheet does it
 * (sheets.jsx BwSheet): that day's entry updated in place, or a new one appended, then the list
 * sorted by day. Returns { state, entry }.
 */
export function applyWeighIn(S, { weight, unit, date, now }) {
  const to = profileUnit(S);
  const w = toStoredBodyWeight(weight, unit, to);
  const list = Array.isArray(S.bodyweight) ? S.bodyweight.map(e => (e && typeof e === 'object' ? { ...e } : e)) : [];
  const old = list.find(e => e && typeof e === 'object' && e.d === date) || null;
  const t = entryStamp(S, date, old, now);
  if (old) { old.w = w; old.t = t; } else list.push({ d: date, w, t });
  list.sort((a, b) => {
    const x = String(a?.d ?? ''), y = String(b?.d ?? '');
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return { state: { ...S, bodyweight: list }, entry: { date, value: w, unit: to } };
}

/**
 * The whole write. `internal` mints the profile's session, `apiUrl` is the api's loopback URL.
 * -> { status, body } with curated bodies only.
 */
export async function logBodyWeight({ profileId, body, internal, apiUrl, now = () => Date.now(), envTz }) {
  const checked = validateInput(body);
  if (checked.error) return { status: 400, body: { error: checked.error } };
  const { input } = checked;

  try {
    const token = await internal.session(profileId);
    if (!token) return { status: 404, body: UNKNOWN_PROFILE };

    const got = await callApi(apiUrl, 'GET', '/api/data', { token });
    // 401 after a fresh mint: the profile was disabled or deleted in between.
    if (got.status === 401) return { status: 404, body: UNKNOWN_PROFILE };
    if (got.status !== 200 || !got.json) return { status: 502, body: NOT_RESPONDING };
    let state = got.json.state;
    let rev = got.json.rev;
    if (!state || typeof state !== 'object') return { status: 409, body: NO_DATA };

    // The day is fixed once, in the profile's zone, so a retry cannot move it.
    const tz = profileTimeZone(state, envTz);
    const date = input.date ?? dayIn(input.measuredMs ?? now(), tz);

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const { state: next, entry } = applyWeighIn(state, { weight: input.weight, unit: input.unit, date, now: now() });
      if (!(entry.value > 0)) return { status: 400, body: { error: 'weight is too small to store' } };
      // No `stamped` flag: the gateway does not stamp its own changes the way the app does, so
      // upstream's sync-stamps treat it as an API writer and stamp what it changed.
      const put = { state: next, baseRev: typeof rev === 'number' ? rev : 0 };
      if (typeof state._wid === 'string') put.baseWid = state._wid;
      const res = await callApi(apiUrl, 'PUT', '/api/data', { token, body: put });
      if (res.status === 200 && res.json) {
        return { status: 200, body: { profile_id: profileId, entry, rev: typeof res.json.rev === 'number' ? res.json.rev : null } };
      }
      if (res.status === 401) return { status: 404, body: UNKNOWN_PROFILE };
      if (res.status !== 409 || !res.json) return { status: 502, body: NOT_RESPONDING };
      // Another device wrote since the read. The 409 carries the current document: re-apply onto
      // it (its _wid becomes the new baseWid) instead of reading again.
      if (!res.json.state || typeof res.json.state !== 'object') return { status: 409, body: NO_DATA };
      state = res.json.state;
      rev = res.json.rev;
    }
    return { status: 409, body: CONFLICT };
  } catch (err) {
    // Only the two typed "cannot reach it" errors become a 502; anything else is a bug and goes
    // to the gateway's catch-all (logged, curated 500).
    if (err instanceof InternalUnavailable || err instanceof ApiUnavailable) return { status: 502, body: NOT_RESPONDING };
    throw err;
  }
}
