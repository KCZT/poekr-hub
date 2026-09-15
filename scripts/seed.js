'use strict';
/* Fills a fresh install with a few nights so the standings and cards have
   something in them. Safe to skip — it refuses to run over real data. */
const { app } = require('../server');
const { db } = require('../src/store');

if (db.players.length > 0) {
  console.log('\n  There are already accounts here. Seeding would muddle real results.');
  console.log('  Delete the data folder first if you want demo data.\n');
  process.exit(1);
}

const PEOPLE = [
  ['riley', 'Riley'], ['sam', 'Sam'], ['dev', 'Dev'], ['nas', 'Nas'], ['kit', 'Kit'], ['bo', 'Bo']
];
const GAMES = ['texas_holdem', 'omaha', 'blackjack', 'seven_stud'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return res.json();
  };

  const accounts = {};
  for (const [username, displayName] of PEOPLE) {
    const r = await call('POST', '/api/auth/signup', { username, displayName, password: 'password1' });
    accounts[username] = r;
    console.log(`  account: ${displayName} / ${username} / password1${r.firstAccount ? '  (poker admin)' : ''}`);
  }
  const host = accounts.riley;

  for (let night = 1; night <= 6; night += 1) {
    const { room } = await call('POST', '/api/rooms', {
      name: `Night ${night}`,
      config: { defaultBuyIn: 20, minBuyIn: 5, buyInIncrement: 5 }
    }, host.token);

    const playing = PEOPLE.map(([u]) => u).filter((u) => u === 'riley' || Math.random() > 0.25);
    for (const u of playing) {
      if (u !== 'riley') await call('POST', `/api/rooms/${room.id}/join`, {}, accounts[u].token);
    }
    await call('POST', `/api/rooms/${room.id}/start`, {}, host.token);

    if (night % 2 === 0) {
      await call('POST', `/api/rooms/${room.id}/segments`, { game: 'blackjack', note: 'intermission' }, host.token);
      await call('POST', `/api/rooms/${room.id}/segments`, { game: pick(GAMES.slice(0, 2)) }, host.token);
    }

    let pot = 0;
    const stacks = {};
    for (const u of playing) {
      const buys = 1 + (Math.random() > 0.7 ? 1 : 0);
      let total = 0;
      for (let b = 0; b < buys; b += 1) {
        const amount = 20;
        const funding = Math.random() > 0.85 ? 'credit' : 'cash';
        await call('POST', `/api/rooms/${room.id}/buyin`,
          { playerId: accounts[u].player.id, amount, funding }, host.token);
        total += amount;
      }
      stacks[u] = total;
      pot += total;
    }

    // Split the pot back out at random, then hand the rounding to the last player.
    const shares = playing.map(() => Math.random());
    const sum = shares.reduce((a, b) => a + b, 0);
    let handed = 0;
    playing.forEach((u, i) => { shares[i] = Math.round((shares[i] / sum) * pot / 5) * 5; });
    playing.forEach((u, i) => { if (i < playing.length - 1) handed += shares[i]; });
    shares[shares.length - 1] = pot - handed;

    for (let i = 0; i < playing.length; i += 1) {
      await call('POST', `/api/rooms/${room.id}/cashout`, {
        playerId: accounts[playing[i]].player.id,
        amount: Math.max(0, shares[i]),
        seatOut: true
      }, host.token);
    }
    const ended = await call('POST', `/api/rooms/${room.id}/end`, { force: true }, host.token);
    console.log(`  night ${night}: ${playing.length} players, ${(ended.settlement?.payments || []).length} payment(s) to settle`);
  }

  db.flushNow();
  server.close();
  console.log('\n  Seeded. Sign in as riley / password1 to look around.\n');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
