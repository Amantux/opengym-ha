// Body-weight unit conversion, the same rule as upstream openGym's convertBodyWeight
// (frontend/src/lib/units.js, v1.4.1). Copied rather than imported: the add-on image carries
// only the upstream api (/app), not the frontend source. test/units.test.js pins this copy to
// vectors generated from upstream's own function, and re-checks them against upstream when the
// source tree is available.
//
// Upstream steps and stores weigh-ins at 0.1 in the profile's unit, so a weigh-in converted
// kg -> lb -> kg comes home for every 0.1-kg value. Plate rounding (convertWeight) is NOT used
// for body weight.

export const LB_PER_KG = 2.2046226218;

/** Upstream convertBodyWeight, verbatim in behaviour: unchanged when the units match. */
export function convertBodyWeight(value, from, to) {
  if (from === to || value == null || value === '' || !Number.isFinite(Number(value))) return value;
  const v = Number(value);
  return Math.round((to === 'lb' ? v * LB_PER_KG : v / LB_PER_KG) * 10) / 10;
}

/** A profile's weight unit as upstream reads it: anything but 'lb' converts as kg. */
export const profileUnit = S => (S && S.unit === 'lb' ? 'lb' : 'kg');

/**
 * `value` in `from`, stored in `to` at upstream's 0.1 step. Same-unit values are rounded too:
 * convertBodyWeight leaves them alone because the app's own input is already on the 0.1 grid,
 * and a smart scale's 80.237 is not.
 */
export function toStoredBodyWeight(value, from, to) {
  return Math.round(Number(convertBodyWeight(value, from, to)) * 10) / 10;
}
