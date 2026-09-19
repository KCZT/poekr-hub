'use strict';
// Storage goes to a throwaway directory; must be first.
require('./lib/sandbox');
/**
 * The app in a real WebKit.
 *
 * This runs against WebKitGTK, which is the same JavaScriptCore and WebCore
 * that Safari uses on a Mac and an iPhone. It is not Safari — the platform
 * integration around it differs — but the engine that parses the JavaScript and
 * applies the CSS is the genuine article, which is where the interesting
 * failures live. A module that throws on iOS throws here too.
 *
 * Every page is served with an error collector injected ahead of the app, so a
 * throw during module evaluation is caught by name rather than inferred from a
 * blank screen.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { app } = require('../server');
const { startWebKit } = require('./lib/webdriver');

let fails = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ` — ${extra}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Catches anything thrown before the app's own code can report it. */
const COLLECTOR = `<script>
  window.__errs = [];
  addEventListener('error', function (e) {
    window.__errs.push((e.message || 'error') + (e.filename ? ' @ ' + e.filename.split('/').pop() : ''));
  });
  addEventListener('unhandledrejection', function (e) {
    window.__errs.push('unhandled rejection: ' + (e.reason && e.reason.message || e.reason));
  });
</script>`;

function harness() {
  const parent = express();
  const shell = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
    .replace('<head>', `<head>\n${COLLECTOR}`);
  parent.get(['/', '/index.html'], (_req, res) => res.type('html').send(shell));
  parent.use(app);
  return parent;
}

// ── Page helpers, run inside WebKit ────────────────────────────────────────
const pageText = () => document.body.innerText;

const clickByText = (sel, txt) => {
  const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(txt));
  if (!el) return false;
  el.click();
  return true;
};

const fillField = (labelText, value) => {
  const label = [...document.querySelectorAll('label')]
    .find((l) => l.querySelector('span') && l.querySelector('span').textContent.includes(labelText));
  const input = label && label.querySelector('input, select, textarea');
  if (!input) return false;
  const proto = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : input.constructor.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
};

const collectErrors = () => window.__errs || [];

(async () => {
  const server = harness().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const wk = await startWebKit();
  if (!wk) {
    console.log('\n  Needs a real WebKit to run against:');
    console.log('    sudo apt-get install -y webkit2gtk-driver xvfb\n');
    server.close();
    process.exit(0);
  }

  console.log(`\nWebKit ${wk.version} (the engine behind Safari on macOS and iOS)`);

  const errorsSoFar = async () => (await wk.eval(collectErrors)) || [];
  const text = () => wk.eval(pageText);
  const click = async (sel, txt) => { const r = await wk.eval(clickByText, sel, txt); await wait(450); return r; };
  const fill = (label, value) => wk.eval(fillField, label, value);

  // ── Does it even load ────────────────────────────────────────────────────
  console.log('\nLoading the app');
  await wk.setWindow(430, 932); // iPhone 14/15/16 Pro Max, in CSS pixels
  await wk.go(base);
  await wait(2500);

  const loadErrors = await errorsSoFar();
  ok('nothing threw while the modules loaded', loadErrors.length === 0, loadErrors.slice(0, 2).join(' | '));

  const landing = await text();
  ok('the page is not blank', (landing || '').trim().length > 0, landing ? '' : 'BLANK PAGE');
  ok('and it is the sign-in screen', /account|sign in|poker/i.test(landing || ''), (landing || '').slice(0, 60));

  const engine = await wk.eval(() => ({
    notification: typeof Notification !== 'undefined',
    serviceWorker: 'serviceWorker' in navigator,
    secure: window.isSecureContext,
    modules: typeof Symbol !== 'undefined'
  }));
  ok('it really is WebKit reporting in', typeof engine.modules === 'boolean', JSON.stringify(engine));

  // ── A whole night ────────────────────────────────────────────────────────
  console.log('\nPlaying a night through it');
  await fill('Username', 'riley');
  await fill('Name people will see', 'Riley');
  await click('button', 'Create account');
  await wait(1400);
  ok('signing up works', /Open a table/.test(await text()), (await text() || '').slice(0, 60));

  await click('button', 'Open a table');
  await wait(600);
  await fill('Table name', 'WebKit');
  await click('.sheet-actions button', 'Open table');
  await wait(1800);
  const room = await text();
  ok('a table opens', /Chips in play/.test(room), room.slice(0, 60));
  ok('the join code rendered', /[A-Z0-9]{5}/.test(room));

  await click('button', 'Deal the first hand');
  await wait(900);
  await click('.actions button', 'Buy in');
  await wait(700);
  ok('the buy-in sheet offers the funding choices', /On credit/.test(await text()));
  await click('.sheet-actions button', 'Take the chips');
  await wait(1200);
  ok('buying in registers', /\$20/.test(await text()), (await text()).slice(0, 80));

  await click('button', 'Switch game');
  await wait(700);
  await fill('Now playing', 'blackjack');
  await wait(400);
  await click('.sheet-actions button', 'Switch');
  await wait(1400);
  ok('switching games works', /Blackjack/.test(await text()));

  await click('button', 'Cash out');
  await wait(700);
  await wk.eval(() => {
    const i = document.querySelector('.sheet input[type=number]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '20');
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(400);
  await click('.sheet-actions button', 'Cash out');
  await wait(1600);
  ok('cashing out settles the night', /Settle up/.test(await text()), (await text()).slice(0, 70));

  // ── The parts most likely to differ in this engine ───────────────────────
  console.log('\nThe bits an engine is most likely to disagree about');
  const css = await wk.eval(() => {
    const card = document.createElement('div');
    card.className = 'pcard';
    document.body.appendChild(card);
    const s = getComputedStyle(card);
    const out = {
      cardStock: s.backgroundColor,
      appHeight: getComputedStyle(document.getElementById('app')).minHeight,
      gridWorks: getComputedStyle(document.querySelector('.readout') || card).display,
      tabbarFixed: getComputedStyle(document.getElementById('tabbar')).position
    };
    card.remove();
    return out;
  });
  ok('custom properties resolved', css.cardStock === 'rgb(242, 235, 217)', css.cardStock);
  ok('dvh units resolved to a real height', /^\d+(\.\d+)?px$/.test(css.appHeight), css.appHeight);
  ok('the tab bar is pinned', css.tabbarFixed === 'fixed', css.tabbarFixed);

  const live = await wk.eval(() => typeof EventSource !== 'undefined');
  ok('live updates are supported', live === true);

  const intl = await wk.eval(() => {
    try {
      return new Date(1788981637501).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).length > 0;
    } catch { return false; }
  });
  ok('the timeline can format clock times', intl === true);

  console.log('\nNothing broke anywhere in that run');
  const finalErrors = await errorsSoFar();
  ok('no JavaScript errors at all', finalErrors.length === 0, finalErrors.slice(0, 3).join(' | '));

  await wk.close();
  server.close();
  console.log(`\n${fails === 0 ? 'All WebKit checks passed.' : `${fails} check(s) failed.`}\n`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
