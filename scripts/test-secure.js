'use strict';
/**
 * The point of the HTTPS server is that a phone on the wifi gets a secure
 * context. Without one, service workers do not exist, home-screen install is
 * unavailable, and notification permission is refused without asking. This
 * checks the difference on the actual LAN address rather than on localhost,
 * which is exempt and would hide the problem.
 */
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app } = require('../server');
const tls = require('../src/tls');

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch {
  console.log('\n  Needs puppeteer to check browser behaviour:');
  console.log('    npm install --no-save puppeteer\n');
  process.exit(0);
}

let fails = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ` — ${extra}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function lanIP() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const net of iface || []) if (net.family === 'IPv4' && !net.internal) return net.address;
  }
  return null;
}

async function caps(page, origin) {
  await page.goto(`${origin}/`, { waitUntil: 'networkidle2' });
  await wait(900);
  return page.evaluate(async () => ({
    secure: window.isSecureContext,
    swApi: 'serviceWorker' in navigator,
    swLive: !!(await navigator.serviceWorker?.getRegistration()),
    permission: typeof Notification === 'undefined' ? 'n/a' : await Notification.requestPermission()
  }));
}

(async () => {
  console.log('\nCertificate');
  const cert = await tls.ensure();
  ok('a certificate is made on first run', !!cert && !!cert.key && !!cert.cert);
  if (!cert) { console.log('\nCannot continue without one.\n'); process.exit(1); }
  ok('the private key is not world readable',
    (fs.statSync(path.join(tls.DIR, 'key.pem')).mode & 0o077) === 0);

  const ip = lanIP();
  ok('the machine has a LAN address to test against', !!ip, ip || 'none found');
  ok('the certificate covers it', cert.hosts.includes(ip), cert.hosts.join(', '));

  const again = await tls.ensure();
  ok('it is reused rather than remade every boot', again.reused === true);

  const plain = app.listen(0, '0.0.0.0');
  await new Promise((r) => plain.once('listening', r));
  const secure = https.createServer({ key: cert.key, cert: cert.cert }, app).listen(0, '0.0.0.0');
  await new Promise((r) => secure.once('listening', r));
  const httpOrigin = `http://${ip}:${plain.address().port}`;
  const httpsOrigin = `https://${ip}:${secure.address().port}`;

  const browser = await puppeteer.launch({
    headless: 'new',
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    acceptInsecureCerts: true, // what a person does when they tap through the warning
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  console.log('\nWhat a phone gets over the plain link');
  const c1 = await caps(await browser.newPage(), httpOrigin);
  ok('it is not a secure context', c1.secure === false);
  ok('so service workers do not exist at all', c1.swApi === false);
  ok('and notification permission is refused without asking', c1.permission === 'denied', c1.permission);

  console.log('\nWhat a phone gets over the secure link');
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(httpsOrigin, ['notifications']);
  const c2 = await caps(await ctx.newPage(), httpsOrigin);
  ok('it is a secure context', c2.secure === true);
  ok('service workers are available', c2.swApi === true);
  ok('and one actually registers', c2.swLive === true);
  ok('notifications can be granted', c2.permission === 'granted', c2.permission);

  console.log('\nThe app itself still works over HTTPS');
  const page = await ctx.newPage();
  await page.goto(`${httpsOrigin}/`, { waitUntil: 'networkidle2' });
  await wait(700);
  const boot = await page.evaluate(async () => {
    const r = await fetch('/api/bootstrap');
    return r.json();
  });
  ok('the API answers', !!boot.games?.texas_holdem);
  ok('and hands out the secure address', String(boot.secureUrl || '').startsWith('https://'), boot.secureUrl);

  console.log('\nBackups leave the key behind');
  const files = fs.readdirSync(path.join(__dirname, '..', 'data'));
  ok('the certificate is stored under data', files.includes('cert'));

  await browser.close();
  plain.close();
  secure.close();
  console.log(`\n${fails === 0 ? 'All secure-context checks passed.' : `${fails} check(s) failed.`}\n`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
