// Screenshots through the fake ingress (tests/e2e/run.sh, opt-in with E2E_SCREENSHOT_DIR).
// Runs in a Playwright container on the e2e network; talks only to the fake ingress at
// 172.30.32.2, so every request the browser makes arrives at the add-on as HA user A.
//
//   node screenshot.mjs <out dir>
//
// 1. /panel.html at 1280x800: HA's sidebar panel, a same-origin iframe of the ingress URL.
//    Proves the gateway's framing rewrite (upstream's DENY would leave the frame blank) and
//    the ingress sign-in (the app inside is past its sign-in screen).
// 2. The ingress URL itself at 390x844 (a phone), the same checks without the frame.
// "Signed in" = upstream's tab bar (frontend/src/components/TabBar.jsx, <nav id="tabbar">) is
// shown, the sign-in screen's buttons (views/Login.jsx: "Sign in with passkey", "Create new
// profile") are not, and the page's own GET api/me answers as HA user A.
// Exit 1 on any failed check. The playwright module is looked up in the usual global places
// (PLAYWRIGHT_MODULE overrides); the browser binary in PLAYWRIGHT_CHROMIUM, else Playwright's
// own, else the first /ms-playwright/chromium-*/chrome-linux/chrome.
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const OUT = process.argv[2] || '/screens';
const INGRESS = 'http://172.30.32.2';
const APP = `${INGRESS}/api/hassio_ingress/abc/`;
const USER_A = 'Alex Example';

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/usr/lib/node_modules/playwright',
    '/usr/local/lib/node_modules/playwright', '/usr/lib/node_modules/@playwright/mcp/node_modules/playwright'].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch { /* next */ }
  }
  throw new Error(`no playwright module found (tried ${candidates.join(', ')}); set PLAYWRIGHT_MODULE`);
}

async function launch(chromium) {
  const args = ['--no-sandbox'];
  if (process.env.PLAYWRIGHT_CHROMIUM) return chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM, args });
  try {
    return await chromium.launch({ args });
  } catch (err) {
    const root = '/ms-playwright';
    const dir = existsSync(root) ? readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().pop() : undefined;
    const exe = dir && path.join(root, dir, 'chrome-linux', 'chrome');
    if (!exe || !existsSync(exe)) throw err;
    return chromium.launch({ executablePath: exe, args });
  }
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`ok - ${name}`); return; }
  failures += 1;
  console.log(`not ok - ${name}${detail === undefined ? '' : `\n    got: ${JSON.stringify(detail)}`}`);
}

/** Watch a page for server errors and blocked frames while it loads. */
function watch(page) {
  const seen = { errors: [], console: [] };
  page.on('response', r => { if (r.status() >= 500) seen.errors.push(`${r.status()} ${r.url()}`); });
  page.on('console', m => { if (m.type() === 'error') seen.console.push(m.text()); });
  return seen;
}

/** The signed-in checks, run against the frame (or page) the app lives in. */
async function assertSignedIn(label, target) {
  const tabbar = target.locator('nav#tabbar');
  let shown = true;
  try { await tabbar.waitFor({ state: 'visible', timeout: 30_000 }); } catch { shown = false; }
  check(`${label}: the app's tab bar is shown (signed in)`, shown);
  const loginButtons = await target.getByText(/^(Sign in with passkey|Create new profile)$/).count();
  check(`${label}: no sign-in / create-profile screen`, loginButtons === 0, loginButtons);
  // The app derives its API base from its own URL; a relative fetch is exactly what it does.
  const me = await target.evaluate(async () => {
    const r = await fetch('api/me', { credentials: 'same-origin' });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  check(`${label}: the page's own GET api/me is HA user A`, me.status === 200 && me.body?.user?.name === USER_A, me);
  const hash = await target.evaluate(() => location.hash);
  check(`${label}: the app routed to its home screen`, hash === '#/home', hash);
}

const { chromium } = loadPlaywright();
const browser = await launch(chromium);
try {
  // 1. The HA panel: the app inside a same-origin iframe.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const seen = watch(page);
    const resp = await page.goto(`${INGRESS}/panel.html`, { waitUntil: 'load', timeout: 60_000 });
    check('panel.html loads', resp?.status() === 200, resp?.status());
    const frameEl = await page.waitForSelector('iframe#panel', { timeout: 10_000 });
    const frame = await frameEl.contentFrame();
    check('the panel iframe has a document (framing allowed)', !!frame);
    if (frame) await assertSignedIn('panel iframe', frame);
    // Let images and fonts settle so the picture is the real one, not a half-painted frame.
    await page.waitForTimeout(1_500);
    const file = path.join(OUT, 'panel-iframe-1280x800.png');
    await page.screenshot({ path: file });
    console.log(`screenshot ${file}`);
    check('panel: no 5xx responses while loading', seen.errors.length === 0, seen.errors);
    check('panel: no frame-blocking console errors', !seen.console.some(t => /frame|X-Frame-Options|frame-ancestors/i.test(t)), seen.console);
    await context.close();
  }
  // 2. The ingress URL on a phone-sized screen.
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const seen = watch(page);
    const resp = await page.goto(APP, { waitUntil: 'load', timeout: 60_000 });
    check('ingress URL loads', resp?.status() === 200, resp?.status());
    await assertSignedIn('ingress URL (390x844)', page);
    await page.waitForTimeout(1_500);
    const file = path.join(OUT, 'ingress-mobile-390x844.png');
    await page.screenshot({ path: file });
    console.log(`screenshot ${file}`);
    check('ingress URL: no 5xx responses while loading', seen.errors.length === 0, seen.errors);
    await context.close();
  }
} catch (e) {
  failures += 1;
  console.log(`not ok - screenshot run crashed: ${e.stack || e}`);
} finally {
  await browser.close();
}
console.log(`# screenshots: ${failures} failed`);
process.exit(failures ? 1 : 0);
