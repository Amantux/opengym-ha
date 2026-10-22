// State documents in upstream openGym v1.4.1's shapes, modelled on frontend/src/lib/demoSeed.js
// (workouts {id, d, start, end, routineId, name, bw, entries, prs, vol}; weigh-ins {d, w, t};
// routines {id, name, emoji, ex}; week keyed by getDay(); dayPlan; queue) and
// api/test/helpers.mjs sampleState. Times are fixed so every expectation below is exact.

// Thursday 2026-10-22 12:30 UTC. In Pacific/Auckland (NZDT, UTC+13) it is already Friday
// 2026-10-23 01:30; in America/New_York (EDT) it is Thursday 08:30.
export const NOW = Date.parse('2026-10-22T12:30:00.000Z');

const at = iso => Date.parse(iso);
const sets = (w, n = 3) => Array.from({ length: n }, () => ({ w, r: 8, done: true }));
const workout = (id, d, startIso, minutes, routineId, name) => {
  const start = at(startIso);
  return {
    id, d, start, end: start + minutes * 60_000, routineId, name, bw: 80.4,
    entries: [{ id: '0025', sets: sets(60), topW: 60 }, { id: '0047', sets: sets(45), topW: 45 }],
    prs: [], vol: 60 * 8 * 3 + 45 * 8 * 3,
  };
};

// Profile in Auckland: "today" is Friday 2026-10-23 there, Thursday in UTC.
export const alex = {
  unit: 'kg', lang: 'en', weekStart: 1, _rev: 42, _ts: at('2026-10-21T06:00:00Z'), _wid: 'a1b2c3d4e5f60718', _wids: ['0011223344556677'],
  reminder: { on: true, time: '07:00', tz: 'Pacific/Auckland', nudge: false, tone: 'friendly' },
  routines: [
    { id: 'r1', name: 'Push A', emoji: '💪', ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }] },
    { id: 'r2', name: 'Pull B', emoji: '🏋️', ex: [{ id: '0047', sets: 3, reps: 8, weight: 45 }] },
    { id: 'r3', name: 'Legs C', emoji: '🦵', ex: [{ id: '0043', sets: 3, reps: 8, weight: 70 }] },
  ],
  // getDay(): 1 Monday, 3 Wednesday, 5 Friday.
  week: { 1: 'r1', 3: 'r3', 5: 'r2' },
  dayPlan: {},
  // Stored out of order on purpose: nothing may rely on the list order.
  workouts: [
    workout('w5', '2026-10-21', '2026-10-20T18:00:00Z', 60, 'r2', 'Pull B'),   // Wed 07:00 NZDT
    workout('w1', '2026-10-16', '2026-10-16T05:00:00Z', 45, 'r1', 'Push A'),   // outside the 7 days
    workout('w6', '2026-10-21', '2026-10-21T05:00:00Z', 52, 'r1', 'Push A'),   // Wed 18:00 NZDT: the last one
    workout('w3', '2026-10-18', '2026-10-18T05:00:00Z', 50, 'r3', 'Legs C'),   // Sunday
    workout('w4', '2026-10-19', '2026-10-19T05:00:00Z', 47, 'r1', 'Push A'),   // Monday
    workout('w2', '2026-10-17', '2026-10-17T05:00:00Z', 40, 'r2', 'Pull B'),   // Saturday, first of the 7 days
  ],
  bodyweight: [
    { d: '2026-10-21', w: 80.2, t: at('2026-10-20T17:30:00Z') },
    { d: '2026-10-20', w: 80.6, t: at('2026-10-19T17:30:00Z') },
    { d: '2026-10-01', w: 82.4, t: at('2026-09-30T17:30:00Z') },
  ],
  measurements: [],
};

// Profile in lb, Sunday-first week, no reminder zone (the container TZ applies), on a planner's
// floating week (S.queue): its first session is done, so today is the second one — whatever the
// weekday plan says. Only upstream's own effectiveRoutineId gets this right.
export const sam = {
  unit: 'lb', weekStart: 0, _rev: 7, _wid: 'ffeeddccbbaa9988',
  reminder: { on: false, time: '08:00', tz: null, nudge: false, tone: 'friendly' },
  routines: [
    { id: 'q1', name: 'Day A', ex: [] },
    { id: 'q2', name: 'Day B', ex: [] },
    { id: 'u1', name: 'Upper', ex: [] },
  ],
  week: { 4: 'u1' },  // Thursday
  dayPlan: {},
  queue: { ids: ['q1', 'q2'], since: at('2026-10-18T12:00:00Z'), startsOn: '2026-10-18', label: 'Week 1' },
  workouts: [
    { id: 's1', d: '2026-10-18', start: at('2026-10-18T14:00:00Z'), end: at('2026-10-18T15:10:00Z'), routineIds: ['q1'], name: 'Day A', entries: [], prs: [] },
    // Dated by its start only (no `d`): 2026-10-17 21:00 in New York, 01:00 UTC on the 18th.
    { id: 's0', start: at('2026-10-18T01:00:00Z'), end: at('2026-10-18T01:30:00Z'), routineId: 'u1', name: 'Upper', entries: [], prs: [] },
  ],
  bodyweight: [
    { d: '2026-10-22', w: 176.4, t: at('2026-10-22T11:00:00Z') },
    { d: '2026-10-22', w: 177, t: at('2026-10-22T11:05:00Z') },  // same day, later stamp: this one
    { d: '2026-10-19', w: 178.2, t: at('2026-10-19T11:00:00Z') },
  ],
};
