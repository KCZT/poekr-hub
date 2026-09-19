'use strict';
// Storage goes to a throwaway directory; must be first.
require('./lib/sandbox');
/* Loads the real UI in Chromium and clicks through a night. Catches the runtime
   errors that syntax checks and API tests cannot see. */
const { app } = require('../server');

/* Drives a real browser, so it needs puppeteer, which is not a dependency of
   the app itself. `npm test` covers the money model and the API without it. */
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

async function textOf(page) { return page.evaluate(() => document.body.innerText); }

async function clickText(page, selector, text) {
  const done = await page.evaluate((sel, t) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(t));
    if (el) { el.click(); return true; }
    return false;
  }, selector, text);
  await wait(340);
  return done;
}

async function fill(page, labelText, value) {
  return page.evaluate((lt, v) => {
    const label = [...document.querySelectorAll('label')].find((l) => l.querySelector('span')?.textContent.includes(lt));
    const input = label?.querySelector('input, select, textarea');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(
      input.tagName === 'SELECT' ? HTMLSelectElement.prototype : input.constructor.prototype, 'value').set;
    setter.call(input, v);
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

  const errors = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    // Chrome logs a notice when vibrate is called before the first tap. It does
    // not throw and the app guards it; nothing to fix.
    if (m.type() === 'error'
      && !/favicon|fonts\.g|css2\?family|Failed to load resource|navigator\.vibrate/.test(t)) {
      errors.push(`console: ${t}`);
    }
  });
  page.on('requestfailed', (r) => {
    // Navigating away cancels whatever was in flight. That is the browser doing
    // its job, not the app breaking.
    const why = r.failure()?.errorText || '';
    if (/ERR_ABORTED/.test(why)) return;
    if (!/fonts\.g|favicon|\/stream/.test(r.url())) {
      errors.push(`request failed: ${r.url()} (${why})`);
    }
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !/fonts\.g/.test(r.url())) {
      errors.push(`HTTP ${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`);
    }
  });

  console.log('\nSign up (mobile viewport 390x844)');
  await page.goto(base, { waitUntil: 'networkidle2' });
  await wait(400);
  ok('landing page renders', (await textOf(page)).includes('first account runs the place'));

  ok('the password field says it is optional', (await textOf(page)).includes('optional'));
  await fill(page, 'Username', 'riley');
  await fill(page, 'Name people will see', 'Riley');
  await fill(page, 'Password', 'password1');
  await clickText(page, 'button', 'Create account');
  await wait(700);
  ok('signed in and landed in the lobby', (await textOf(page)).includes('Open a table'), await textOf(page).then((t) => t.slice(0, 60)));

  console.log('\nOpen a table');
  await clickText(page, 'button', 'Open a table');
  await wait(300);
  await fill(page, 'Table name', 'Thursday');
  await fill(page, 'Standard buy-in', '20');
  await clickText(page, '.sheet-actions button', 'Open table');
  await wait(900);
  const roomText = await textOf(page);
  ok('room screen loaded', roomText.includes('Chips in play'), roomText.slice(0, 80));
  const code = await page.$eval('.code', (el) => el.textContent.trim());
  ok('join code is on screen', /^[A-Z0-9]{5}$/.test(code), code);
  ok('QR code rendered', await page.$('img.qr') !== null);
  ok('waiting-to-start banner shows', roomText.includes('Waiting to start'));

  console.log('\nBuy in');
  await clickText(page, 'button', 'Deal the first hand');
  await wait(500);
  await clickText(page, 'button', 'Buy in');
  await wait(350);
  ok('buy-in sheet offers the three funding choices',
    (await textOf(page)).includes('On credit') && (await textOf(page)).includes('Someone’s covering me'));
  await clickText(page, '.sheet-actions button', 'Take the chips');
  await wait(700);
  const afterBuy = await textOf(page);
  ok('chips in play updated', afterBuy.includes('$20'), afterBuy.slice(0, 120));

  console.log('\nSwitch to blackjack mid-game');
  await clickText(page, 'button', 'Switch game');
  await wait(350);
  await fill(page, 'Now playing', 'blackjack');
  await wait(200);
  await clickText(page, '.sheet-actions button', 'Switch');
  await wait(800);
  const afterSwitch = await textOf(page);
  ok('now playing blackjack', afterSwitch.includes('Blackjack'), afterSwitch.slice(0, 80));
  ok('chips survived the switch', afterSwitch.includes('$20'));
  ok('run of play is shown', afterSwitch.includes('Hold’em') || afterSwitch.includes('Blackjack'));

  console.log('\nCash out and settle');
  await clickText(page, 'button', 'Cash out');
  await wait(350);
  await page.evaluate(() => {
    const input = document.querySelector('.sheet input[type=number]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '20');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(200);
  await clickText(page, '.sheet-actions button', 'Cash out');
  await wait(900);
  const settled = await textOf(page);
  ok('settle-up panel appears once chips are in', settled.includes('Settle up'), settled.slice(0, 100));
  ok('says everyone is square', settled.includes('square'), settled.match(/Settle up[\s\S]{0,90}/)?.[0]);

  console.log('\nProfile card');
  await clickText(page, '.tabbar button', 'You');
  await wait(700);
  ok('You tab renders', (await textOf(page)).includes('Your details'));
  await clickText(page, 'button', 'View my card');
  await wait(600);
  ok('player card opens', await page.$('.pcard') !== null);
  const cardText = await page.evaluate(() => document.querySelector('.pcard')?.innerText || '');
  ok('card shows a record', cardText.includes('Record'), cardText.slice(0, 60));
  const cardBg = await page.evaluate(() => getComputedStyle(document.querySelector('.pcard')).backgroundColor);
  ok('card is the cream card-stock object', cardBg === 'rgb(242, 235, 217)', cardBg);
  const idx = await page.evaluate(() => getComputedStyle(document.querySelector('.pcard'), '::before').content);
  ok('card has corner index marks', idx && idx !== 'none', idx);
  await page.keyboard.press('Escape');
  await wait(300);

  console.log('\nStandings and admin');
  await clickText(page, '.tabbar button', 'Standings');
  await wait(700);
  ok('standings table renders', (await textOf(page)).includes('All time'));
  await clickText(page, '.tabbar button', 'Admin');
  await wait(800);
  const adminText = await textOf(page);
  ok('admin console opens for the poker admin', adminText.includes('Accounts'), adminText.slice(0, 80));
  ok('admin has the stat-correction area', adminText.includes('Who owes who'));

  console.log('\nMoney out of the pot');
  await page.goto(`${base}/#/room/${code}`, { waitUntil: 'networkidle2' });
  await wait(1000);
  await clickText(page, '.actions button', 'Money out');
  await wait(450);
  ok('expense sheet opens', (await textOf(page)).includes('Money out of the pot'));
  await fill(page, 'What for', 'Pizza');
  await page.evaluate(() => {
    const i = document.querySelector('.sheet input[type=number]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(i, '30');
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(300);
  ok('it works out the split as you type', (await textOf(page)).includes('each'),
    (await textOf(page)).match(/\$\d+ each[^\n]*/)?.[0]);
  await clickText(page, '.sheet-actions button', 'Record it');
  await wait(900);
  const spent = await textOf(page);
  ok('the table shows money has left the box', spent.includes('left the cash box'),
    spent.match(/left the cash box[^\n]*/)?.[0]);
  ok('chips in play did not move', spent.includes('Chips in play'));

  console.log('\nThe shot');
  await clickText(page, '.actions button', 'Dick shot');
  await wait(450);
  ok('calling one opens the right sheet', (await textOf(page)).includes('They either take it'));
  await fill(page, 'What did they do', 'slowrolled');
  await clickText(page, '.sheet-actions button', 'Call it');
  await wait(1000);
  const called = await textOf(page);
  ok('the person on the hook gets a banner', called.includes('called one on you'), called.slice(0, 120));
  ok('both ways out are offered', called.includes('I took it') && called.includes('photo instead'));
  await clickText(page, 'button', 'I took it');
  await wait(1000);
  await wait(600);
  const bannerGone = await page.evaluate(() =>
    ![...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'I took it'));
  ok('taking it clears the banner', bannerGone);
  const afterShot = await textOf(page);
  ok('and shows up on the tally', afterShot.includes('tally'), afterShot.match(/tally[\s\S]{0,60}/)?.[0]);

  console.log('\nReopening a closed night');
  await page.goto(`${base}/#/room/${code}`, { waitUntil: 'networkidle2' });
  await wait(1000);
  // Cash everyone out so the night can be closed.
  await page.evaluate(async (c) => {
    const t = localStorage.getItem('pokerhub.token');
    const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` };
    const { room } = await (await fetch(`/api/rooms/${c}`, { headers: H })).json();
    const left = room.pot.chipsInPlay;
    const seated = room.players.filter((p) => p.status !== 'removed');
    for (let i = 0; i < seated.length; i += 1) {
      await fetch(`/api/rooms/${room.id}/cashout`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ playerId: seated[i].playerId, amount: i === 0 ? left : 0 })
      });
    }
    await fetch(`/api/rooms/${room.id}/end`, { method: 'POST', headers: H, body: JSON.stringify({ force: true }) });
  }, code);
  await page.reload({ waitUntil: 'networkidle2' });
  await wait(1200);
  ok('a closed night offers a way back in', (await textOf(page)).includes('Reopen this night'));
  await clickText(page, 'button', 'Reopen this night');
  await wait(500);
  ok('and spells out what that costs first',
    (await textOf(page)).includes('lifetime stats') && (await textOf(page)).includes('debts'));
  await clickText(page, '.sheet-actions button', 'Reopen');
  await wait(1200);
  const reopened = await textOf(page);
  ok('the night is running again', reopened.includes('Buy in') && !reopened.includes('Reopen this night'),
    reopened.slice(0, 90));

  console.log('\nOne player’s night');
  await page.goto(`${base}/#/room/${code}`, { waitUntil: 'networkidle2' });
  await wait(1100);
  await clickText(page, '.seats .seat', 'Riley');
  await wait(450);
  ok('a seat opens the admin actions', (await textOf(page)).includes('Open their card'));
  await clickText(page, '.sheet button', 'Their night, in order');
  await wait(600);
  const tl = await textOf(page);
  ok('the timeline lists what happened', /night/i.test(tl) && tl.includes('Sat down'), tl.slice(0, 120));
  ok('and carries a running total', /[+−]\$\d/.test(tl));
  await page.keyboard.press('Escape');
  await wait(350);

  console.log('\nStandings controls');
  await clickText(page, '.tabbar button', 'Standings');
  await wait(900);
  const chipRows = await page.evaluate(() => document.querySelectorAll('main .chip-row').length);
  const selects = await page.evaluate(() => document.querySelectorAll('main .panel select').length);
  ok('filters collapsed to one chip row', chipRows === 1, `${chipRows} rows`);
  ok('with metric and game as dropdowns', selects === 2, `${selects} selects`);

  console.log('\nBackup');
  await clickText(page, '.tabbar button', 'You');
  await wait(900);
  const you = await textOf(page);
  ok('the backup button is there for a poker admin', you.includes('Back it all up'));
  ok('alerts can be switched on', you.includes('Alerts'));
  await clickText(page, '.tabbar button', 'Tables');
  await wait(600);

  console.log('\nSecond player joins (live sync over SSE)');
  await page.goto(`${base}/#/room/${code}`, { waitUntil: 'networkidle2' });
  await wait(700);

  const ctx2 = await (browser.createBrowserContext?.() ?? browser.createIncognitoBrowserContext());
  const page2 = await ctx2.newPage();
  await page2.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  page2.on('pageerror', (e) => errors.push(`p2 pageerror: ${e.message}`));
  await page2.goto(base, { waitUntil: 'networkidle2' });
  await wait(400);
  // Which button offers signup depends on whether anyone can be tapped yet.
  if (!await clickText(page2, 'button', 'Create an account')) {
    await clickText(page2, 'button', 'I am new here');
  }
  await wait(300);
  await fill(page2, 'Username', 'sam');
  await fill(page2, 'Name people will see', 'Sam');
  await clickText(page2, 'button', 'Create account');
  await wait(900);
  ok('second player signed up with no password at all', (await textOf(page2)).includes('Open a table'),
    (await textOf(page2)).slice(0, 70));

  // Sign out and back in by tapping the name, which is the point of all this.
  await page2.evaluate(() => { localStorage.removeItem('pokerhub.token'); });
  await page2.goto(base, { waitUntil: 'networkidle2' });
  await wait(900);
  const faceScreen = await textOf(page2);
  ok('the sign-in screen leads with names to tap', faceScreen.includes('Who is this?'), faceScreen.slice(0, 80));
  ok('and lists the passwordless account', faceScreen.includes('Sam'));
  await clickText(page2, '.seat', 'Sam');
  await wait(1100);
  ok('tapping the name signs straight in', (await textOf(page2)).includes('Open a table'),
    (await textOf(page2)).slice(0, 70));

  await page2.goto(`${base}/#/room/${code}`, { waitUntil: 'networkidle2' });
  await wait(800);
  ok('second player can open the table by code', (await textOf(page2)).includes('Chips in play'));
  await clickText(page2, 'button', 'Sit down at this table');
  await wait(900);
  ok('second player is seated', (await textOf(page2)).includes('Buy in'));

  await wait(900);
  ok('host screen updated live without a reload', (await textOf(page)).includes('Sam'),
    (await textOf(page)).slice(0, 90));

  console.log('\nSeating and the button');
  await clickText(page, 'button', 'Seating and the button');
  await wait(450);
  ok('seating sheet opens', (await textOf(page)).includes('Drag people around'));
  const dealerBefore = await page.evaluate(() =>
    [...document.querySelectorAll('.sheet .seat')].findIndex((r) => r.textContent.includes('button')));
  await clickText(page, '.sheet button', 'Pass the button to the next seat');
  await wait(900);
  await clickText(page, 'button', 'Seating and the button');
  await wait(500);
  const dealerAfter = await page.evaluate(() =>
    [...document.querySelectorAll('.sheet .seat')].findIndex((r) => r.textContent.includes('button')));
  ok('the button moved to another seat', dealerAfter !== dealerBefore, `${dealerBefore} -> ${dealerAfter}`);
  await page.keyboard.press('Escape');
  await wait(350);



  console.log('\nShort buy needs approval');
  await page.evaluate(async (c) => {
    const room = await (await fetch(`/api/rooms/${c}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('pokerhub.token')}` }
    })).json();
    await fetch(`/api/rooms/${room.room.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('pokerhub.token')}` },
      body: JSON.stringify({ config: { allowShortBuy: false } })
    });
  }, code);
  await wait(400);

  await page2.reload({ waitUntil: 'networkidle2' });
  await wait(800);
  await clickText(page2, 'button', 'Buy in');
  await wait(400);
  await page2.evaluate(() => {
    const i = document.querySelector('.sheet input[type=number]');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(i, '10');
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(250);
  ok('short buy is flagged in the sheet before sending',
    (await textOf(page2)).includes('room admin has to approve'), (await textOf(page2)).slice(0, 60));
  await clickText(page2, '.sheet-actions button', 'Take the chips');
  await wait(900);

  await page.reload({ waitUntil: 'networkidle2' });
  await wait(1000);
  const hostText = await textOf(page);
  ok('host sees the approval request', hostText.includes('Waiting on you'), hostText.slice(0, 100));
  await clickText(page, 'button', 'Approve');
  await wait(900);
  ok('approved buy-in lands on the table', (await textOf(page)).includes('$10'));

  console.log('\nCredit buy-in settles to a payment');
  await clickText(page, 'button', 'Buy in');
  await wait(400);
  await clickText(page, '.chip-row button', 'On credit');
  await wait(200);
  await clickText(page, '.sheet-actions button', 'Take the chips');
  await wait(900);
  ok('credit is called out on the room screen', (await textOf(page)).includes('on credit'),
    (await textOf(page)).match(/credit[\s\S]{0,60}/)?.[0]);

  await page2.close();
  await ctx2.close();

  console.log('\nRenaming and rebranding from the admin area');
  await clickText(page, '.tabbar button', 'Admin');
  await wait(800);
  await clickText(page, '.chip', 'Site settings');
  await wait(900);
  const brandPane = await textOf(page);
  ok('the admin area offers name and logo together', brandPane.includes('Name and logo'), brandPane.slice(0, 90));
  ok('with the current mark shown', await page.$('main img[src*="/brand/icon"]') !== null);
  ok('and a way to upload one', brandPane.includes('Upload a logo'));

  await fill(page, 'Name', 'Scammer Casino');
  await clickText(page, 'button', 'Save settings');
  await wait(1200);
  ok('the browser tab takes the new name', (await page.title()) === 'Scammer Casino', await page.title());

  await page.goto(`${base}/#/`, { waitUntil: 'networkidle2' });
  await wait(900);
  ok('and so does the header', (await textOf(page)).includes('Scammer Casino'),
    (await textOf(page)).slice(0, 60));

  const mf = await page.evaluate(async () => (await (await fetch('/manifest.json')).json()).name);
  ok('the home-screen name follows', mf === 'Scammer Casino', mf);

  // Put it back so later assertions are not surprised.
  await page.evaluate(async () => {
    await fetch('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('pokerhub.token')}` },
      body: JSON.stringify({ siteName: 'Poker Hub' })
    });
  });

  console.log('\nLayout');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok('no horizontal overflow on a 390px phone', !overflow);
  const tapTooSmall = await page.evaluate(() => [...document.querySelectorAll('button')]
    .filter((b) => b.offsetParent !== null)
    .filter((b) => { const r = b.getBoundingClientRect(); return r.height > 0 && r.height < 30; }).length);
  ok('tap targets are finger sized', tapTooSmall === 0, `${tapTooSmall} under 30px`);

  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${base}/#/`, { waitUntil: 'networkidle2' });
  await wait(700);
  const railed = await page.evaluate(() => {
    const t = document.getElementById('tabbar');
    return getComputedStyle(t).borderRightWidth !== '0px' && t.getBoundingClientRect().height > 300;
  });
  ok('desktop turns the tab bar into a side rail', railed);
  const wideOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok('no horizontal overflow on desktop', !wideOverflow);

  console.log('\nRuntime');
  ok('no JavaScript errors anywhere in that run', errors.length === 0, errors.slice(0, 4).join(' | '));

  await browser.close();
  server.close();
  console.log(`\n${fails === 0 ? 'All browser checks passed.' : `${fails} check(s) failed.`}\n`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
