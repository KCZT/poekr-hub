'use strict';
// Storage goes to a throwaway directory; must be first.
require('./lib/sandbox');
/**
 * Geometry and visibility, measured on the phones people actually bring.
 *
 * Two questions, asked of every screen at every size:
 *   is everything that should be on screen actually on screen, and reachable
 *   past the notch and the home indicator;
 *   and is everything that should be hidden actually gone, rather than merely
 *   transparent or pushed offscreen where a screen reader still finds it.
 *
 * Safe-area insets are simulated rather than real — a headless browser has no
 * Dynamic Island — by overriding the custom properties the layout derives from
 * env(). That exercises the arithmetic, which is where the mistakes are.
 */
const { app } = require('../server');

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch {
  console.log('\n  This test measures a real browser and needs puppeteer:');
  console.log('    npm install --no-save puppeteer\n');
  process.exit(0);
}

let fails = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ` — ${extra}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Portrait CSS pixels, and the insets iOS reports for each.
 * The Pro models from the 14 onwards carry a 59px top inset for the Dynamic
 * Island and 34px at the bottom for the home indicator.
 */
const DEVICES = [
  { name: 'iPhone SE (3rd gen)', w: 375, h: 667, top: 20, bottom: 0 },
  { name: 'Galaxy S23',          w: 360, h: 780, top: 24, bottom: 0 },
  { name: 'iPhone 14 Pro',       w: 393, h: 852, top: 59, bottom: 34 },
  { name: 'iPhone 15 Pro',       w: 393, h: 852, top: 59, bottom: 34 },
  { name: 'iPhone 16 Pro',       w: 402, h: 874, top: 59, bottom: 34 },
  { name: 'iPhone 14 Pro Max',   w: 430, h: 932, top: 59, bottom: 34 },
  { name: 'iPhone 16 Pro Max',   w: 440, h: 956, top: 59, bottom: 34 },
  { name: 'Pixel 8 Pro',         w: 412, h: 892, top: 24, bottom: 0 }
];

/**
 * Headless has no notch, so hand the layout the insets it would have seen.
 * This has to be added after the stylesheet it overrides, or it loses the
 * cascade to app.css's own :root block and quietly measures nothing.
 */
async function simulateInsets(page, top, bottom) {
  await page.addStyleTag({
    content: `:root { --rail: ${bottom}px; }
              .appbar { padding-top: ${10 + top}px !important; }`
  });
}

/** Everything on screen that a finger is meant to hit. */
function measureVisible() {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const seen = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const tabbar = document.getElementById('tabbar');
  const tabRect = tabbar && seen(tabbar) ? tabbar.getBoundingClientRect() : null;

  const small = [];
  for (const el of document.querySelectorAll('button, a.btn, input, select, [role=button]')) {
    if (!seen(el)) continue;
    const r = el.getBoundingClientRect();
    // Only judge what is on screen; a control scrolled far below is not a tap
    // target yet. 40px allows for sub-pixel rounding on a 44px rule.
    if (r.bottom < 0 || r.top > vh) continue;
    if (r.height < 40) small.push(`${el.tagName}.${el.className || '-'}:${Math.round(r.height)}px`);
  }

  const clipped = [];
  for (const el of document.querySelectorAll('.name, .btn, h1, h2, .code, .v, .amt')) {
    if (!seen(el)) continue;
    const s = getComputedStyle(el);
    // An ellipsis is a decision, not a defect: the title is meant to trail off
    // rather than push the header sideways.
    if (s.textOverflow === 'ellipsis') continue;
    if (s.overflow !== 'visible' && el.scrollWidth > el.clientWidth + 1) {
      clipped.push(`${el.tagName}.${el.className || '-'}: ${el.scrollWidth}>${el.clientWidth}`);
    }
  }

  const offRight = [];
  for (const el of document.querySelectorAll('main *')) {
    if (!seen(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 && r.width <= vw) offRight.push(el.className || el.tagName);
  }

  return {
    vw,
    vh,
    scrollWidth: document.documentElement.scrollWidth,
    overflows: document.documentElement.scrollWidth > vw + 1,
    tab: tabRect ? { top: tabRect.top, bottom: tabRect.bottom, height: tabRect.height } : null,
    smallTargets: small.slice(0, 5),
    clippedText: clipped.slice(0, 5),
    offRight: offRight.slice(0, 5)
  };
}

/** Anything meant to be gone should really be gone, not just invisible. */
function auditHidden() {
  const leaks = [];
  for (const el of document.querySelectorAll('[hidden], .hidden')) {
    const s = getComputedStyle(el);
    if (s.display !== 'none') {
      leaks.push(`${el.tagName}#${el.id || ''}.${el.className || ''} => display:${s.display}`);
    }
  }
  // A control that is invisible but still tabbable is worse than one that is
  // simply present: it traps keyboard focus in nothing.
  const ghosts = [];
  for (const el of document.querySelectorAll('button, a[href], input, select')) {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const invisible = s.visibility === 'hidden' || Number(s.opacity) === 0;
    if (invisible && el.tabIndex >= 0 && r.width > 0) ghosts.push(el.tagName + '.' + el.className);
  }
  return { leaks, ghosts };
}

async function clickText(page, sel, text) {
  const done = await page.evaluate((s, t) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.textContent.trim().includes(t));
    if (el) { el.click(); return true; }
    return false;
  }, sel, text);
  await wait(420);
  return done;
}

async function fill(page, labelText, value) {
  return page.evaluate((lt, v) => {
    const label = [...document.querySelectorAll('label')].find((l) => l.querySelector('span')?.textContent.includes(lt));
    const input = label?.querySelector('input, select, textarea');
    if (!input) return false;
    const proto = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : input.constructor.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, labelText, value);
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await puppeteer.launch({
    headless: 'new',
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server']
  });

  // ── Set up a table with enough in it to fill a screen ────────────────────
  const setup = await browser.newPage();
  await setup.setViewport({ width: 393, height: 852 });
  await setup.goto(base, { waitUntil: 'networkidle2' });
  await wait(700);
  await fill(setup, 'Username', 'riley');
  await fill(setup, 'Name people will see', 'Riley');
  await clickText(setup, 'button', 'Create account');
  await wait(900);
  await clickText(setup, 'button', 'Open a table');
  await wait(400);
  await fill(setup, 'Table name', 'Thursday night at the house');
  await clickText(setup, '.sheet-actions button', 'Open table');
  await wait(1300);
  const code = await setup.$eval('.code', (el) => el.textContent.trim());
  await clickText(setup, 'button', 'Deal the first hand');
  await wait(500);
  const token = await setup.evaluate(() => localStorage.getItem('pokerhub.token'));

  await setup.evaluate(async (c) => {
    const t = localStorage.getItem('pokerhub.token');
    const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` };
    const { room } = await (await fetch(`/api/rooms/${c}`, { headers: H })).json();
    const ids = [];
    for (const name of ['Sam', 'Devinder', 'Nas', 'Kit']) {
      const r = await (await fetch(`/api/rooms/${room.id}/guests`, {
        method: 'POST', headers: H, body: JSON.stringify({ name })
      })).json();
      ids.push(r.guest.id);
    }
    const buy = (playerId, amount, funding, coveredBy) => fetch(`/api/rooms/${room.id}/buyin`, {
      method: 'POST', headers: H, body: JSON.stringify({ playerId, amount, funding, coveredBy })
    });
    await buy(null, 20, 'cash');
    await buy(ids[0], 120, 'cash');
    await buy(ids[1], 20, 'credit');
    await buy(ids[2], 20, 'covered', ids[0]);
    await buy(ids[3], 15, 'cash');
    await fetch(`/api/rooms/${room.id}/expenses`, {
      method: 'POST', headers: H, body: JSON.stringify({ label: 'Pizza', amount: 32, beneficiary: 'external', fundedFrom: 'box' })
    });
    await fetch(`/api/rooms/${room.id}/shots`, {
      method: 'POST', headers: H, body: JSON.stringify({ playerId: ids[0], reason: 'slowrolled the nuts' })
    });
  }, code);
  await setup.close();

  const SCREENS = [
    { path: '/#/', name: 'Tables' },
    { path: `/#/room/${code}`, name: 'The table' },
    { path: '/#/board', name: 'Standings' },
    { path: '/#/me', name: 'You' },
    { path: '/#/admin', name: 'Admin' }
  ];

  // ── Every screen, every phone ────────────────────────────────────────────
  for (const d of DEVICES) {
    console.log(`\n${d.name}  ${d.w}x${d.h}${d.top ? `  insets ${d.top}/${d.bottom}` : ''}`);
    const page = await browser.newPage();
    await page.setViewport({ width: d.w, height: d.h, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await page.evaluateOnNewDocument((t) => { localStorage.setItem('pokerhub.token', t); }, token);

    let worstOverflow = null;
    let worstTargets = null;
    let worstClip = null;
    let hiddenLeak = null;

    for (const screen of SCREENS) {
      await page.goto(base + screen.path, { waitUntil: 'networkidle2' });
      await simulateInsets(page, d.top, d.bottom);
      await wait(900);
      const m = await page.evaluate(measureVisible);
      const h = await page.evaluate(auditHidden);

      if (m.overflows && !worstOverflow) worstOverflow = `${screen.name}: ${m.scrollWidth}px wide in ${m.vw}px`;
      if (m.smallTargets.length && !worstTargets) worstTargets = `${screen.name}: ${m.smallTargets.join(', ')}`;
      if (m.clippedText.length && !worstClip) worstClip = `${screen.name}: ${m.clippedText.join(', ')}`;
      if (h.leaks.length && !hiddenLeak) hiddenLeak = `${screen.name}: ${h.leaks.join(', ')}`;

      // The tab bar has to sit fully on screen with its labels clear of the
      // home indicator.
      if (screen.name === 'The table') {
        const tab = m.tab;
        ok('the tab bar is on screen', tab && tab.bottom <= m.vh + 1 && tab.top >= 0,
          tab ? `top ${Math.round(tab.top)}, bottom ${Math.round(tab.bottom)}, viewport ${m.vh}` : 'not rendered');
        ok('and clears the home indicator', !tab || tab.height >= 44 + d.bottom,
          tab ? `${Math.round(tab.height)}px tall, needs ${44 + d.bottom}` : '');

        // Content must not end up underneath it.
        const gap = await page.evaluate(() => {
          const t = document.getElementById('tabbar').getBoundingClientRect();
          const main = document.querySelector('main');
          const style = getComputedStyle(main);
          document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
          const last = [...document.querySelectorAll('main .panel')].pop();
          const r = last ? last.getBoundingClientRect() : null;
          return {
            pad: parseFloat(style.paddingBottom),
            tabHeight: t.height,
            lastBottom: r ? r.bottom : null,
            tabTop: document.getElementById('tabbar').getBoundingClientRect().top
          };
        });
        ok('the page reserves room for the tab bar', gap.pad >= gap.tabHeight,
          `padding ${Math.round(gap.pad)}px vs bar ${Math.round(gap.tabHeight)}px`);
        ok('and the last panel is not left under it',
          gap.lastBottom === null || gap.lastBottom <= gap.tabTop + 1,
          gap.lastBottom ? `panel ends ${Math.round(gap.lastBottom)}, bar starts ${Math.round(gap.tabTop)}` : '');
      }
    }

    ok('no screen scrolls sideways', !worstOverflow, worstOverflow || '');
    ok('every on-screen control is finger sized', !worstTargets, worstTargets || '');
    ok('no text is cut off by its own box', !worstClip, worstClip || '');
    ok('nothing marked hidden is still displayed', !hiddenLeak, hiddenLeak || '');

    await page.close();
  }

  // ── What should and should not be on screen, by state ────────────────────
  console.log('\nThings that should be visible, and things that should not');
  const page = await browser.newPage();
  await page.setViewport({ width: 393, height: 852, isMobile: true, hasTouch: true });
  await page.evaluateOnNewDocument((t) => { localStorage.setItem('pokerhub.token', t); }, token);

  await page.goto(`${base}/#/`, { waitUntil: 'networkidle2' });
  await simulateInsets(page, 59, 34);
  await wait(900);
  const lobby = await page.evaluate(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden';
    };
    return {
      back: vis('#backBtn'),
      tabbar: vis('#tabbar'),
      appbar: vis('#appbar'),
      adminTab: [...document.querySelectorAll('#tabbar button')].some((b) => b.textContent.includes('Admin'))
    };
  });
  ok('the back arrow is hidden outside a room', lobby.back === false, String(lobby.back));
  ok('the tab bar and header are up', lobby.tabbar === true && lobby.appbar === true);
  ok('a poker admin sees the Admin tab', lobby.adminTab === true);

  await page.goto(`${base}/#/room/${code}`, { waitUntil: 'networkidle2' });
  await simulateInsets(page, 59, 34);
  await wait(1100);
  const inRoom = await page.evaluate(() => {
    const el = document.querySelector('#backBtn');
    return getComputedStyle(el).display !== 'none';
  });
  ok('and appears inside a room', inRoom === true);

  // A sheet should cover the page and sit inside the viewport.
  await clickText(page, '.actions button', 'Buy in');
  await wait(700);
  const sheet = await page.evaluate(() => {
    const scrim = document.querySelector('.scrim');
    const box = document.querySelector('.sheet');
    if (!scrim || !box) return null;
    const s = scrim.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return {
      scrimCoversWidth: s.width >= document.documentElement.clientWidth - 1,
      scrimCoversHeight: s.height >= document.documentElement.clientHeight - 1,
      sheetOnScreen: b.top >= 0 && b.bottom <= document.documentElement.clientHeight + 1,
      sheetWidth: b.width,
      vw: document.documentElement.clientWidth,
      bottomPad: parseFloat(getComputedStyle(box).paddingBottom)
    };
  });
  ok('the sheet dims the whole screen behind it',
    sheet && sheet.scrimCoversWidth && sheet.scrimCoversHeight, JSON.stringify(sheet));
  ok('the sheet itself fits on screen', sheet && sheet.sheetOnScreen,
    sheet ? `top ${Math.round(sheet.top || 0)}` : '');
  ok('and keeps its buttons above the home indicator', sheet && sheet.bottomPad >= 34,
    sheet ? `${Math.round(sheet.bottomPad)}px` : '');

  await page.keyboard.press('Escape');
  await wait(500);
  const closed = await page.evaluate(() => document.querySelectorAll('.scrim').length);
  ok('and it really goes away when dismissed', closed === 0, `${closed} left behind`);

  // Nothing invisible should still be reachable by keyboard.
  const ghosts = await page.evaluate(auditHidden);
  ok('no invisible control still takes keyboard focus', ghosts.ghosts.length === 0,
    ghosts.ghosts.slice(0, 3).join(', '));

  await page.close();
  await browser.close();
  server.close();
  console.log(`\n${fails === 0 ? 'All layout checks passed.' : `${fails} check(s) failed.`}\n`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
