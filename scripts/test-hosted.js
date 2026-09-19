'use strict';
// Storage goes to a throwaway directory; must be first.
require('./lib/sandbox');
/**
 * Hosted mode is a claim about what is closed. This checks the claim rather
 * than trusting it, by booting the app twice — once as a laptop on a table,
 * once as something behind Caddy — and asking the same questions of both.
 */
const { fork } = require('child_process');
const path = require('path');

let fails = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ` — ${extra}` : ''}`);
};

const ROOT = path.join(__dirname, '..');
const sandbox = require('./lib/sandbox');

// Never the real data folder: this deletes what it finds.
const wipe = sandbox.reset;

/** Boots the real server in its own process so config is read fresh. */
function boot(env) {
  return new Promise((resolve, reject) => {
    const port = 3200 + Math.floor(Math.random() * 300);
    const child = fork(path.join(ROOT, 'server.js'), [], {
      env: { ...process.env, PORT: String(port), ...env },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const started = Date.now();
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
        if (r.ok) {
          clearInterval(poll);
          resolve({ base: `http://127.0.0.1:${port}`, child, log: () => out });
        }
      } catch {
        if (Date.now() - started > 15000) {
          clearInterval(poll);
          child.kill();
          reject(new Error(`server did not start:\n${out}`));
        }
      }
    }, 250);
  });
}

async function call(base, method, p, { token, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = {};
  try { json = await res.json(); } catch { /* not json */ }
  return { ...json, httpStatus: res.status };
}

(async () => {
  const PUBLIC = 'https://poker.example.com';

  // ── On a laptop, as it has always been ───────────────────────────────────
  console.log('\nOn a local network');
  wipe();
  let s = await boot({ DISABLE_TLS: '1' });
  let host = await call(s.base, 'POST', '/api/auth/signup', {
    body: { username: 'riley', displayName: 'Riley' }
  });
  ok('an account can skip having a password', !!host.token, host.error);
  ok('and tapping the name signs you in',
    !!(await call(s.base, 'POST', '/api/auth/pick', { body: { playerId: host.player.id } })).token);

  const lanRoom = (await call(s.base, 'POST', '/api/rooms', {
    token: host.token, body: { name: 'Kitchen', password: 'aces' }
  })).room;
  ok('reading a table needs no sign-in',
    (await call(s.base, 'GET', `/api/rooms/${lanRoom.id}`)).httpStatus === 200);
  ok('nor does the player list', (await call(s.base, 'GET', '/api/players')).httpStatus === 200);
  ok('the app says it is not hosted', (await call(s.base, 'GET', '/api/bootstrap')).hosted === false);
  s.child.kill();
  await new Promise((r) => setTimeout(r, 400));

  // ── Same database, now on a public address ───────────────────────────────
  console.log('\nThe same install, hosted');
  s = await boot({ PUBLIC_URL: PUBLIC });
  const bootInfo = await call(s.base, 'GET', '/api/bootstrap');
  ok('the app knows it is hosted', bootInfo.hosted === true);
  ok('passwordless accounts still work', bootInfo.allowPasswordlessAccounts === true);
  ok('it hands out the public address, not a LAN one', bootInfo.networkUrl === PUBLIC, bootInfo.networkUrl);
  ok('and the secure address too', bootInfo.secureUrl === PUBLIC, bootInfo.secureUrl);

  console.log('\n  A password is not demanded just because it is public');
  const tapped = await call(s.base, 'POST', '/api/auth/pick', { body: { playerId: host.player.id } });
  ok('tapping a name still signs you in', !!tapped.token, tapped.error);
  const blank = await call(s.base, 'POST', '/api/auth/login', { body: { username: 'riley' } });
  ok('so does the form with the password left blank', !!blank.token, blank.error);
  ok('the faces list still lists them', (await call(s.base, 'GET', '/api/auth/faces')).players.length > 0);
  const noPwSignup = await call(s.base, 'POST', '/api/auth/signup', {
    body: { username: 'chancer', displayName: 'Chancer' }
  });
  ok('and new accounts can skip one too', !!noPwSignup.token, noPwSignup.error);
  ok('the startup notice is honest about what that means',
    /anyone who finds this/i.test(s.log()), '');
  ok('and names a passwordless admin specifically', /poker admin/i.test(s.log()), '');

  console.log('\n  What is closed to strangers');
  for (const [label, p] of [
    ['the table itself', `/api/rooms/${lanRoom.id}`],
    ['the settle-up', `/api/rooms/${lanRoom.id}/settlement`],
    ['the CSV of the ledger', `/api/rooms/${lanRoom.id}/export.csv`],
    ['the live feed', `/api/rooms/${lanRoom.id}/stream`],
    ['the list of tables', '/api/rooms'],
    ['the player list', '/api/players'],
    ['the standings', '/api/players/leaderboard'],
    ['anyone’s card', `/api/players/${host.player.id}/card`]
  ]) {
    const r = await call(s.base, 'GET', p);
    ok(`${label} needs a sign-in`, r.httpStatus === 401, `HTTP ${r.httpStatus}`);
  }

  console.log('\n  Signing in restores what should be visible');
  const withPw = await call(s.base, 'POST', '/api/auth/signup', {
    body: { username: 'sam', displayName: 'Sam', password: 'password1' }
  });
  ok('an account with a password can be made', !!withPw.token, withPw.error);
  ok('and can read the standings',
    (await call(s.base, 'GET', '/api/players/leaderboard', { token: withPw.token })).httpStatus === 200);

  const peek = await call(s.base, 'GET', `/api/rooms/${lanRoom.id}`, { token: withPw.token });
  ok('but still cannot read a table they are not at', peek.httpStatus === 403, peek.error);
  const csvPeek = await call(s.base, 'GET', `/api/rooms/${lanRoom.id}/export.csv`, { token: withPw.token });
  ok('nor download its ledger', csvPeek.httpStatus === 403);
  await call(s.base, 'POST', `/api/rooms/${lanRoom.id}/join`, { token: withPw.token, body: { password: 'aces' } });
  ok('joining the table opens it up',
    (await call(s.base, 'GET', `/api/rooms/${lanRoom.id}`, { token: withPw.token })).httpStatus === 200);

  console.log('\n  Believing the proxy about who is asking');
  // Caddy forwards the real client address. If the app does not trust it, every
  // visitor looks like the proxy and they all share one budget of guesses —
  // so one person fumbling would lock out the internet.
  const guess = (ip, username) => fetch(`${s.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ username, password: 'nope' })
  });
  let lockedAt = null;
  for (let i = 0; i < 40; i += 1) {
    const r = await guess('203.0.113.9', `ghost${i}`);
    if (r.status === 429) { lockedAt = i + 1; break; }
  }
  ok('one address guessing a lot gets shut down', lockedAt !== null, `after ${lockedAt} tries`);
  const other = await guess('198.51.100.4', 'someone-else');
  ok('a different address is untouched by it', other.status !== 429, `HTTP ${other.status}`);

  console.log('\n  Shared links still work without an account');
  const sam = withPw.token;
  const shared = await call(s.base, 'POST', '/api/players/me/share', { token: sam, body: { enabled: true } });
  ok('a share link opens for anyone',
    (await call(s.base, 'GET', `/api/share/player/${shared.shareToken}`)).httpStatus === 200);

  // Bound to loopback only, so nothing reaches it except through the proxy.
  const lan = Object.values(require('os').networkInterfaces()).flat()
    .find((n) => n && n.family === 'IPv4' && !n.internal);
  if (lan) {
    let reachable = false;
    try {
      const r = await fetch(`http://${lan.address}:${new URL(s.base).port}/api/bootstrap`, {
        signal: AbortSignal.timeout(2000)
      });
      reachable = r.ok;
    } catch { reachable = false; }
    ok('nothing answers on the network address directly', !reachable,
      reachable ? `still reachable on ${lan.address}` : 'loopback only');
  }

  s.child.kill();
  await new Promise((r) => setTimeout(r, 400));

  // ── For anyone who does want the door shut ───────────────────────────────
  console.log('\nHosted, with REQUIRE_PASSWORDS=1');
  s = await boot({ PUBLIC_URL: PUBLIC, REQUIRE_PASSWORDS: '1' });
  ok('the app says passwordless accounts are off',
    (await call(s.base, 'GET', '/api/bootstrap')).allowPasswordlessAccounts === false);
  const shutTap = await call(s.base, 'POST', '/api/auth/pick', { body: { playerId: host.player.id } });
  ok('tapping a name is refused', shutTap.httpStatus === 403, shutTap.error);
  const shutBlank = await call(s.base, 'POST', '/api/auth/login', { body: { username: 'riley' } });
  ok('and a blank password with it', shutBlank.httpStatus === 403, shutBlank.error);
  ok('the faces list goes empty', (await call(s.base, 'GET', '/api/auth/faces')).players.length === 0);
  ok('new accounts must have one', (await call(s.base, 'POST', '/api/auth/signup', {
    body: { username: 'nochance', displayName: 'No Chance' }
  })).httpStatus === 400);
  ok('an account that has one still signs in',
    !!(await call(s.base, 'POST', '/api/auth/login', {
      body: { username: 'sam', password: 'password1' }
    })).token);
  ok('and the notice names who is locked out', /riley/.test(s.log()), '');
  s.child.kill();
  await new Promise((r) => setTimeout(r, 400));

  // ── And back again ───────────────────────────────────────────────────────
  console.log('\nBack on a local network');
  s = await boot({ DISABLE_TLS: '1' });
  ok('reads open up again',
    (await call(s.base, 'GET', `/api/rooms/${lanRoom.id}`)).httpStatus === 200);
  ok('the passwordless account works again',
    !!(await call(s.base, 'POST', '/api/auth/pick', { body: { playerId: host.player.id } })).token);
  ok('and the password set while hosted still works',
    !!(await call(s.base, 'POST', '/api/auth/login', { body: { username: 'sam', password: 'password1' } })).token);
  s.child.kill();

  wipe();
  console.log(`\n${fails === 0 ? 'All hosting checks passed.' : `${fails} check(s) failed.`}\n`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
