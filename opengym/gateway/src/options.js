// The ONE reader of the add-on's options (/data/options.json). The entrypoint asks for resolved
// values through `node src/cli.js resolve`, and the gateway calls resolveOptions() itself, so
// the shell never parses options.json and the two can never disagree about a default.
//
// Precedence: a non-empty option -> the declared default. "" (what the HA UI writes for a
// cleared field) and null mean unset. external_url is validated HERE, at the point of use,
// because options can also arrive by hand-edited files that no API validated.
import fs from 'node:fs';

const LANG_TAG = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/;
// Every resolved value is printed as RESOLVED_<NAME>=<value> and read by a shell. Refusing
// anything outside this set means no value can ever carry quoting, spaces or `$(...)` into it.
const SHELL_SAFE = /^[A-Za-z0-9._:/@-]*$/;
const BOOLEANS = ['password_login', 'invite_only', 'allow_guest'];

const unset = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
// Operator-supplied text quoted in a problem message: JSON-escaped (no raw newlines in the log)
// and cut short.
const quote = v => JSON.stringify(String(v).slice(0, 200));

function resolveExternalUrl(raw, problems) {
  if (unset(raw)) return { ORIGIN: 'http://localhost:8099', RP_ID: 'localhost', DIRECT_ACCESS: 'false' };
  if (typeof raw !== 'string') {
    problems.push('external_url must be text, for example https://gym.example.com');
    return null;
  }
  const text = raw.trim();
  let url;
  try { url = new URL(text); } catch {
    problems.push(`external_url ${quote(text)} is not a URL; use the address you open openGym at, for example https://gym.example.com`);
    return null;
  }
  const before = problems.length;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') problems.push(`external_url must start with http:// or https:// (got ${quote(url.protocol)})`);
  if (url.username || url.password) problems.push('external_url must not contain a user name or password');
  if (url.pathname !== '' && url.pathname !== '/') problems.push(`external_url must be just the address, without a path (got ${quote(url.pathname)})`);
  // `?` and `#` with nothing after them parse to an empty search/hash, so the raw text is checked too.
  if (url.search || text.includes('?')) problems.push('external_url must not contain a query (?...)');
  if (url.hash || text.includes('#')) problems.push('external_url must not contain a fragment (#...)');
  if (problems.length !== before) return null;
  return { ORIGIN: url.origin, RP_ID: url.hostname, DIRECT_ACCESS: 'true' };
}

/**
 * Options object -> { resolved, problems }. Every problem is collected, so a broken
 * configuration is fixed in one round instead of one error per restart. `resolved` is null
 * whenever there is any problem.
 */
export function resolveOptions(options) {
  const problems = [];
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return { resolved: null, problems: ['options.json must hold a JSON object'] };
  }
  const resolved = {};
  const url = resolveExternalUrl(options.external_url, problems);
  if (url) Object.assign(resolved, url);

  for (const key of BOOLEANS) {
    const v = options[key];
    if (v === undefined || v === null) resolved[key.toUpperCase()] = '0';
    else if (typeof v === 'boolean') resolved[key.toUpperCase()] = v ? '1' : '0';
    else problems.push(`${key} must be true or false (got ${quote(v)})`);
  }

  const lang = options.default_lang;
  if (unset(lang)) resolved.DEFAULT_LANG = '';
  else if (typeof lang === 'string' && LANG_TAG.test(lang.trim())) resolved.DEFAULT_LANG = lang.trim();
  else problems.push(`default_lang ${quote(lang)} is not a language tag such as de or pt-BR`);

  for (const [name, value] of Object.entries(resolved)) {
    if (!SHELL_SAFE.test(value)) problems.push(`${name} would resolve to ${quote(value)}, which has characters outside [A-Za-z0-9._:/@-]; use a plain host name`);
  }
  return problems.length ? { resolved: null, problems } : { resolved, problems };
}

/** Read and resolve the options file. A missing file (plain Docker, no Supervisor) = all defaults. */
export function resolveOptionsFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return resolveOptions({});
    return { resolved: null, problems: [`${file} could not be read (${e.code || 'error'})`] };
  }
  let options;
  try { options = JSON.parse(text); } catch {
    return { resolved: null, problems: [`${file} is not valid JSON`] };
  }
  return resolveOptions(options);
}

/** The CLI's output lines, in a fixed order. */
export const RESOLVED_ORDER = ['ORIGIN', 'RP_ID', 'DIRECT_ACCESS', 'PASSWORD_LOGIN', 'INVITE_ONLY', 'ALLOW_GUEST', 'DEFAULT_LANG'];
export function formatResolved(resolved) {
  return RESOLVED_ORDER.map(name => `RESOLVED_${name}=${resolved[name]}`).join('\n') + '\n';
}
