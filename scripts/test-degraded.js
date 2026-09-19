'use strict';
// Storage goes to a throwaway directory; must be first.
require('./lib/sandbox');
/**
 * The app on browsers that are missing things.
 *
 * Engines differ mostly by what they leave out, and what they leave out is
 * where an app breaks. iOS Safari has no Notification object at all in an
 * ordinary tab; Firefox has no app badge and no Web Share on the desktop;
 * neither of them has ever had vibration on Apple hardware. A phone missing any
 * of it still has to run the app perfectly, because tracking money does not
 * depend on a single one.
 *
 * Each profile below removes exactly what that engine does not provide and then
 * plays a night. It is a simulation of the API surface, not of the engine — the
 * real WebKit run lives in test-webkit.js — but it is the thing that catches
 * the failure that actually happened: a single `Notification?.permission` at
 * the top of a module threw a ReferenceError while the module was still
 * loading, because optional chaining forgives a null value but not an
 * identifier that was never declared, and every iPhone got a blank page.
 * Chromium has all of these, so nothing else could see it.
 */
const { app } = require('../server');

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch {
  console.log('\n  This test drives a real browser and needs puppeteer:');
  console.log('    npm install --no-save puppeteer');
  console.log('  The money and API tests run without it: npm test\n');
  process.exit(0);
}

let fails = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ` — ${extra}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs before any of the app's own code, and takes the listed APIs away. */
function stripApis(spec) {
  for (const name of spec.globals || []) {
    try { delete window[name]; } catch { /* non-configurable */ }
  }
  for (const name of spec.onNavigator || []) {
    try { Object.defineProperty(navigator, name, { get: () => undefined, configurable: true }); } catch { /* fixed */ }
  }
}

/**
 * What each engine genuinely lacks. Worth re-checking against caniuse when
 * these move — Firefox picked up wake lock at 126, for instance.
 */
const PROFILES = [
  {
    name: 'iOS Safari, ordinary tab',
    globals: ['Notification', 'PushManager'],
    onNavigator: ['vibrate', 'wakeLock', 'setAppBadge', 'clearAppBadge'],
    // iOS only offers notifications to an app on the home screen.
    expectAlertsOffered: false
  },
  {
    name: 'Firefox, desktop',
    globals: [],
    onNavigator: ['setAppBadge', 'clearAppBadge', 'share'],
    expectAlertsOffered: true
  },
  {
    name: 'Firefox, Android',
    globals: [],
    onNavigator: ['setAppBadge', 'clearAppBadge', 'wakeLock'],
    expectAlertsOffered: true
  }
];

async function clickText(page, sel, text) {
  const done = await page.evaluate((s, t) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.textContent.trim().includes(t));
    if (el) { el.click(); return true; }
    return false;
  }, sel, text);
  await wait(400);
  return done;
}

async function fill(page, labelText, value) {
  return page.evaluate((lt, v) => {
    const label = [...document.querySelectorAll('label')].find((l) => l.querySelector('span')?.textContent.includes(lt));
    const input = label?.querySelector('input, select, textarea');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set;
    setter.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, labelText, value);
}

const text = (page) => page.evaluate(() => document.body.innerText);

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await puppeteer.launch({
    headless: 'new',
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server']
  });

  let account = 0;

  for (const profile of PROFILES) {
    console.log(`\n${profile.name}`);
    // A clean context each time, so one profile's sign-in does not carry over.
    const ctx = await (browser.createBrowserContext?.() ?? browser.createIncognitoBrowserContext());
    const page = await ctx.newPage();
    const errors = [];

    await page.setViewport({ width: 393, height: 852, isMobile: true, hasTouch: true });
    await page.evaluateOnNewDocument(stripApis, profile);
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      const t = m.text();
      if (m.type() === 'error' && !/favicon|fonts\.g|css2\?family|Failed to load resource|vibrate/.test(t)) {
        errors.push(`console: ${t}`);
      }
    });

    await page.goto(base, { waitUntil: 'networkidle2' });
    await wait(1000);

    const gone = await page.evaluate((spec) => {
      const missing = [];
      for (const n of spec.globals || []) if (typeof window[n] !== 'undefined') missing.push(`${n} still here`);
      for (const n of spec.onNavigator || []) if (navigator[n]) missing.push(`navigator.${n} still here`);
      return missing;
    }, profile);
    ok('the browser really is missing what it should be', gone.length === 0, gone.join(', '));

    const landing = await text(page);
    ok('the page is not blank', landing.trim().length > 0, landing ? '' : 'BLANK PAGE');
    ok('nothing threw while the modules loaded', errors.length === 0, errors.slice(0, 2).join(' | '));

    // A whole night, on this engine's API surface.
    // Once one profile has left a passwordless account behind, the sign-in
    // screen leads with faces to tap rather than the form, so ask for the form.
    if (!await clickText(page, 'button', 'Create an account')) {
      await clickText(page, 'button', 'I am new here');
    }
    await wait(300);
    const user = `player${++account}`;
    await fill(page, 'Username', user);
    await fill(page, 'Name people will see', `Player ${account}`);
    await clickText(page, 'button', 'Create account');
    await wait(1000);
    ok('signing up works', (await text(page)).includes('Open a table'), (await text(page)).slice(0, 50));

    await clickText(page, 'button', 'Open a table');
    await wait(450);
    await fill(page, 'Table name', 'Sofa');
    await clickText(page, '.sheet-actions button', 'Open table');
    await wait(1200);
    ok('a table opens', (await text(page)).includes('Chips in play'), (await text(page)).slice(0, 50));

    // Starting a game asks for the wake lock; this is where a missing one throws.
    await clickText(page, 'button', 'Deal the first hand');
    await wait(600);
    await clickText(page, '.actions button', 'Buy in');
    await wait(450);
    await clickText(page, '.sheet-actions button', 'Take the chips');
    await wait(1000);
    ok('buying in works', (await text(page)).includes('$20'), (await text(page)).slice(0, 60));

    // Sharing a table is where a missing navigator.share would throw.
    await clickText(page, 'button', 'Share link');
    await wait(600);
    ok('sharing a table does not throw without Web Share', errors.length === 0,
      errors.slice(0, 2).join(' | '));

    await clickText(page, '.tabbar button', 'You');
    await wait(1000);
    const you = await text(page);
    if (profile.expectAlertsOffered) {
      ok('alerts are offered, because this engine has them',
        /Turn on alerts|test one|blocking alerts/.test(you),
        you.match(/Alerts[\s\S]{0,90}/)?.[0]?.replace(/\n/g, ' ') || '');
    } else {
      ok('alerts explain themselves instead of offering a dead switch',
        /home screen/i.test(you) && !/Turn on alerts/.test(you),
        you.match(/Alerts[\s\S]{0,110}/)?.[0]?.replace(/\n/g, ' ') || '');
    }

    ok('no JavaScript errors anywhere in that run', errors.length === 0,
      errors.slice(0, 3).join(' | '));

    await page.close();
    await ctx.close?.();
  }

  await browser.close();
  server.close();
  console.log(`\n${fails === 0 ? 'All degraded-browser checks passed.' : `${fails} check(s) failed.`}\n`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
