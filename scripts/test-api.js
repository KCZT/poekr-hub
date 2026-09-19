'use strict';
// Storage goes to a throwaway directory; must be first.
require('./lib/sandbox');
/* Drives the real HTTP API through a full poker night. */
const { app } = require('../server');
const { db } = require('../src/store');

let fails = 0, base;
const ok = (label, cond, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ` — ${extra}` : ''}`);
};

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 120) }; }
  return { ...json, httpStatus: res.status };
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  console.log('\nSetup');
  const boot = await call('GET', '/api/bootstrap');
  ok('bootstrap responds', boot.httpStatus === 200 && !!boot.games.texas_holdem);
  ok('blackjack is available as a mid-game switch', !!boot.games.blackjack);

  const host = await call('POST', '/api/auth/signup', { body: { username: 'host', displayName: 'Riley', password: 'password1' } });
  ok('first account becomes the poker admin', host.player?.role === 'site_admin', host.error);
  const T = host.token;

  const guests = {};
  for (const [u, n] of [['sam', 'Sam'], ['dev', 'Dev'], ['nas', 'Nas']]) {
    const r = await call('POST', '/api/auth/signup', { body: { username: u, displayName: n, password: 'password1' } });
    guests[u] = r;
    ok(`${n} signed up as a plain player`, r.player?.role === 'player', r.error);
  }

  console.log('\nRoom and roles');
  const created = await call('POST', '/api/rooms', {
    token: T,
    body: { name: 'Thursday', password: 'aces', config: { defaultBuyIn: 20, minBuyIn: 5, buyInIncrement: 5, allowShortBuy: false } }
  });
  const room = created.room;
  ok('room created with a join code', /^[A-Z0-9]{5}$/.test(room.code || ''), room?.code);
  ok('creator is room admin', room.isAdmin === true);

  const wrongPw = await call('POST', `/api/rooms/${room.id}/join`, { token: guests.sam.token, body: { password: 'nope' } });
  ok('wrong table password is refused', wrongPw.httpStatus === 401);

  for (const u of ['sam', 'dev', 'nas']) {
    const j = await call('POST', `/api/rooms/${room.code}/join`, { token: guests[u].token, body: { password: 'aces' } });
    ok(`${u} joined by code`, j.room?.players.some((p) => p.playerId === guests[u].player.id), j.error);
  }
  const notAdmin = await call('PATCH', `/api/rooms/${room.id}`, { token: guests.sam.token, body: { name: 'Hijacked' } });
  ok('a player cannot change room settings', notAdmin.httpStatus === 403);

  await call('POST', `/api/rooms/${room.id}/admins`, { token: T, body: { playerId: guests.dev.player.id } });
  const devEdit = await call('PATCH', `/api/rooms/${room.id}`, { token: guests.dev.token, body: { name: 'Thursday night' } });
  ok('promoted room admin can change room settings', devEdit.room?.name === 'Thursday night', devEdit.error);

  const roomAdminBlocked = await call('GET', '/api/admin/players', { token: guests.dev.token });
  ok('room admin is NOT a poker admin', roomAdminBlocked.httpStatus === 403);
  const siteAdminOk = await call('GET', '/api/admin/players', { token: T });
  ok('poker admin reaches the admin area', siteAdminOk.httpStatus === 200);

  await call('POST', `/api/rooms/${room.id}/start`, { token: T });

  console.log('\nBuy-ins');
  const short = await call('POST', `/api/rooms/${room.id}/buyin`, { token: guests.sam.token, body: { amount: 10 } });
  ok('short buy is held for approval, not rejected outright', short.pending === true, short.error);
  const req = short.request;
  const approved = await call('POST', `/api/rooms/${room.id}/requests/${req.id}`, { token: T, body: { approve: true } });
  ok('room admin approves the short buy', approved.room?.players.find((p) => p.playerId === guests.sam.player.id)?.money.buyIn === 10, approved.error);

  const offGrid = await call('POST', `/api/rooms/${room.id}/buyin`, { token: T, body: { playerId: guests.nas.player.id, amount: 23 } });
  ok('off-increment buy-in refused with a reason', offGrid.httpStatus === 400 && /steps of/.test(offGrid.error || ''), offGrid.error);

  await call('POST', `/api/rooms/${room.id}/buyin`, { token: T, body: { amount: 20 } });
  await call('POST', `/api/rooms/${room.id}/buyin`, { token: guests.dev.token, body: { amount: 20 } });
  const fronted = await call('POST', `/api/rooms/${room.id}/buyin`, {
    token: T, body: { playerId: guests.nas.player.id, amount: 20, funding: 'covered', coveredBy: guests.dev.player.id }
  });
  ok('one player can front another’s buy-in', !fronted.error, fronted.error);
  const credit = await call('POST', `/api/rooms/${room.id}/buyin`, {
    token: T, body: { playerId: guests.sam.player.id, amount: 20, funding: 'credit' }
  });
  ok('credit buy-in recorded', !credit.error, credit.error);

  const state = await call('GET', `/api/rooms/${room.id}`, { token: T });
  ok('chips in play add up', state.room.pot.chipsInPlay === 90, `got ${state.room.pot.chipsInPlay}`);
  ok('credit tracked separately from cash', state.room.pot.onCredit === 20, `got ${state.room.pot.onCredit}`);

  console.log('\nSwitching games mid-session');
  const bj = await call('POST', `/api/rooms/${room.id}/segments`, {
    token: T, body: { game: 'blackjack', note: 'intermission', config: { tableMin: 1, tableMax: 25 } }
  });
  ok('table switched to blackjack', bj.room?.segment.game === 'blackjack', bj.error);
  ok('chips survive the switch', bj.room.pot.chipsInPlay === 90, `got ${bj.room?.pot.chipsInPlay}`);
  const back = await call('POST', `/api/rooms/${room.id}/segments`, { token: T, body: { game: 'texas_holdem' } });
  ok('and back to hold’em', back.room?.segment.game === 'texas_holdem');
  ok('three segments on the record', back.room.segments.length === 3, `got ${back.room?.segments.length}`);

  console.log('\nCash out and settle');
  const overdraw = await call('POST', `/api/rooms/${room.id}/cashout`, { token: T, body: { amount: 500 } });
  ok('cannot cash out more chips than exist', overdraw.httpStatus === 400, overdraw.error);

  await call('POST', `/api/rooms/${room.id}/cashout`, { token: T, body: { amount: 50, seatOut: true } });
  await call('POST', `/api/rooms/${room.id}/cashout`, { token: T, body: { playerId: guests.dev.player.id, amount: 40, seatOut: true } });
  await call('POST', `/api/rooms/${room.id}/cashout`, { token: T, body: { playerId: guests.sam.player.id, amount: 0, seatOut: true } });
  await call('POST', `/api/rooms/${room.id}/cashout`, { token: T, body: { playerId: guests.nas.player.id, amount: 0, seatOut: true } });

  const settle = await call('GET', `/api/rooms/${room.id}/settlement`, { token: T });
  ok('chips fully reconciled', Math.abs(settle.pot.chipsInPlay) < 0.01, `left over ${settle.pot.chipsInPlay}`);
  const sum = settle.positions.reduce((n, p) => n + p.result, 0);
  ok('results sum to zero', Math.abs(sum) < 0.01, `got ${sum}`);
  console.log('        payments:');
  for (const p of settle.payments) {
    console.log(`          ${settle.names[p.from]} -> ${settle.names[p.to]}  $${p.amount}  (${p.reason})`);
  }
  ok('settlement is shorter than the ledger', settle.payments.length <= 3, `${settle.payments.length} payments`);
  const bal = {};
  for (const p of settle.payments) {
    bal[p.from] = (bal[p.from] || 0) - p.amount;
    bal[p.to] = (bal[p.to] || 0) + p.amount;
  }
  const worst = Math.max(...settle.positions.map((p) => Math.abs(p.settlementNet - (bal[p.playerId] || 0))));
  ok('everyone ends square', worst < 0.011, `worst off by ${worst}`);

  const ended = await call('POST', `/api/rooms/${room.id}/end`, { token: T, body: {} });
  ok('night closes out', ended.room?.status === 'ended', ended.error);

  console.log('\nAfterwards');
  const card = await call('GET', `/api/players/${guests.dev.player.id}/card`, { token: T });
  ok('profile card has lifetime stats', card.stats?.sessions === 1, JSON.stringify(card.stats?.sessions));
  ok('profile card shows head to head', !!card.headToHead);
  ok('standing balances recorded from the night', Array.isArray(card.balances));

  const lb = await call('GET', '/api/players/leaderboard', { token: T });
  ok('leaderboard has everyone from the night', lb.rows?.length === 4, `${lb.rows?.length} rows`);
  ok('leaderboard sorted by net', lb.rows[0].net >= lb.rows.at(-1).net);

  const shareRoom = await call('POST', `/api/rooms/${room.id}/share`, { token: T, body: { enabled: true } });
  const pub = await call('GET', `/api/share/room/${shareRoom.shareToken}`);
  ok('shared leaderboard opens without signing in', pub.httpStatus === 200 && pub.rows.length === 4, `status ${pub.httpStatus} token=${shareRoom.shareToken} rows=${pub.rows && pub.rows.length} err=${pub.error}`);

  const shareMe = await call('POST', '/api/players/me/share', { token: guests.dev.token, body: { enabled: true } });
  const pubMe = await call('GET', `/api/share/player/${shareMe.shareToken}`);
  ok('personal stat card shares publicly', pubMe.httpStatus === 200 && pubMe.player.displayName === 'Dev', pubMe.error);

  console.log('\nPoker admin powers');
  const adj = await call('POST', `/api/admin/players/${guests.sam.player.id}/stats`, {
    token: T, body: { field: 'net', target: 500, reason: 'migrating old spreadsheet' }
  });
  ok('poker admin can correct a stat', adj.lifetime?.net === 500, adj.error);
  ok('the correction is flagged, not hidden', adj.lifetime?.adjusted === true);
  const undo = await call('DELETE', `/api/admin/players/${guests.sam.player.id}/stats/${adj.adjustment.id}`, { token: T });
  ok('and it can be rolled back', undo.lifetime?.adjusted === false, undo.error);

  const reset = await call('POST', `/api/admin/players/${guests.nas.player.id}/password`, { token: T, body: { password: 'brandnew1' } });
  ok('poker admin resets a password', reset.ok === true, reset.error);
  const relog = await call('POST', '/api/auth/login', { body: { username: 'nas', password: 'brandnew1' } });
  ok('the new password works', !!relog.token, relog.error);
  const oldTok = await call('GET', '/api/auth/me', { token: guests.nas.token });
  ok('old sessions were signed out', oldTok.httpStatus === 401);

  const demote = await call('PATCH', `/api/admin/players/${host.player.id}`, { token: T, body: { role: 'player' } });
  ok('the last poker admin cannot demote themselves', demote.httpStatus === 400, demote.error);

  const audit = await call('GET', '/api/admin/audit', { token: T });
  ok('privileged actions are on the audit log', audit.audit?.some((a) => a.action === 'admin.stat_adjusted'));

  console.log('\nMoney out of the pot');
  const room2 = (await call('POST', '/api/rooms', {
    token: T, body: { name: 'Expenses', config: { defaultBuyIn: 20, minBuyIn: 5, buyInIncrement: 5 } }
  })).room;
  for (const u of ['sam', 'dev']) {
    await call('POST', `/api/rooms/${room2.id}/join`, { token: guests[u].token, body: {} });
  }
  await call('POST', `/api/rooms/${room2.id}/start`, { token: T });
  for (const who of [null, guests.sam.player.id, guests.dev.player.id]) {
    await call('POST', `/api/rooms/${room2.id}/buyin`, { token: T, body: { playerId: who, amount: 20 } });
  }
  const pizza = await call('POST', `/api/rooms/${room2.id}/expenses`, {
    token: T, body: { label: 'Pizza', amount: 31, beneficiary: 'external', fundedFrom: 'box' }
  });
  ok('an expense is recorded', !pizza.error, pizza.error);
  ok('chips are untouched by it', pizza.room?.pot.chipsInPlay === 60, `got ${pizza.room?.pot.chipsInPlay}`);
  ok('the box shows the money gone', pizza.room?.pot.spent === 31, `got ${pizza.room?.pot.spent}`);
  const shares = pizza.room.ledger.find((e) => e.type === 'expense').shares;
  ok('split three ways', shares.length === 3);
  ok('shares add up to the exact amount, cents and all',
    Math.abs(shares.reduce((n, x) => n + x.amount, 0) - 31) < 0.001,
    shares.map((x) => x.amount).join('+'));

  const noLabel = await call('POST', `/api/rooms/${room2.id}/expenses`, {
    token: T, body: { amount: 10 }
  });
  ok('an expense needs a reason', noLabel.httpStatus === 400, noLabel.error);
  const notAdmin2 = await call('POST', `/api/rooms/${room2.id}/expenses`, {
    token: guests.sam.token, body: { label: 'Beer', amount: 10 }
  });
  ok('only a room admin can spend the pot', notAdmin2.httpStatus === 403);

  await call('POST', `/api/rooms/${room2.id}/cashout`, { token: T, body: { amount: 30 } });
  await call('POST', `/api/rooms/${room2.id}/cashout`, { token: T, body: { playerId: guests.sam.player.id, amount: 30 } });
  await call('POST', `/api/rooms/${room2.id}/cashout`, { token: T, body: { playerId: guests.dev.player.id, amount: 0 } });
  const set2 = await call('GET', `/api/rooms/${room2.id}/settlement`, { token: T });
  ok('chips reconcile with an expense in play', Math.abs(set2.pot.chipsInPlay) < 0.01);
  const bal2 = {};
  for (const p of set2.payments) {
    bal2[p.from] = (bal2[p.from] || 0) - p.amount;
    bal2[p.to] = (bal2[p.to] || 0) + p.amount;
  }
  const worst2 = Math.max(...set2.positions.map((p) => Math.abs(p.settlementNet - (bal2[p.playerId] || 0))));
  ok('everyone still ends square with the pizza folded in', worst2 < 0.011, `off by ${worst2}`);

  console.log('\nSeats and the button');
  const seats = (await call('GET', `/api/rooms/${room2.id}`, { token: T })).room;
  const reversed = seats.players.map((p) => p.playerId).reverse();
  const reseated = await call('POST', `/api/rooms/${room2.id}/seats`, { token: T, body: { order: reversed } });
  ok('seats can be reordered', reseated.room?.players[0].playerId === reversed[0], reseated.error);
  const badOrder = await call('POST', `/api/rooms/${room2.id}/seats`, { token: T, body: { order: [reversed[0]] } });
  ok('a seating that drops someone is refused', badOrder.httpStatus === 400, badOrder.error);

  const before = (await call('GET', `/api/rooms/${room2.id}`, { token: T })).room.dealerId;
  const passed = await call('POST', `/api/rooms/${room2.id}/dealer`, { token: T, body: {} });
  ok('the button moves on', passed.room?.dealerId !== before, `${before} -> ${passed.room?.dealerId}`);
  ok('and lands on someone at the table',
    passed.room?.players.some((p) => p.playerId === passed.room.dealerId && p.isDealer));

  console.log('\nThe shot');
  const room3 = (await call('POST', '/api/rooms', { token: T, body: { name: 'Shots' } })).room;
  await call('POST', `/api/rooms/${room3.id}/join`, { token: guests.sam.token, body: {} });
  ok('a table names it by default', room3.config.shotName === 'Dick shot', room3.config.shotName);

  const called = await call('POST', `/api/rooms/${room3.id}/shots`, {
    token: guests.sam.token, body: { playerId: host.player.id, reason: 'slowrolled' }
  });
  ok('anyone at the table can call one', !called.error, called.error);
  ok('it shows as outstanding', called.room?.openPenalties.length === 1);

  const doubleUp = await call('POST', `/api/rooms/${room3.id}/shots`, {
    token: guests.sam.token, body: { playerId: host.player.id }
  });
  ok('they cannot be stacked up on one person', doubleUp.httpStatus === 400, doubleUp.error);

  const notYours = await call('POST', `/api/rooms/${room3.id}/shots/${called.room.openPenalties[0].id}`, {
    token: guests.dev.token, body: { took: true }
  });
  ok('someone else cannot answer for you', notYours.httpStatus === 403);

  const took = await call('POST', `/api/rooms/${room3.id}/shots/${called.room.openPenalties[0].id}`, {
    token: T, body: { took: true }
  });
  ok('taking it clears it', took.room?.openPenalties.length === 0, took.error);
  ok('and it counts', took.room?.players.find((p) => p.playerId === host.player.id)?.shots.taken === 1);

  const called2 = await call('POST', `/api/rooms/${room3.id}/shots`, {
    token: guests.sam.token, body: { playerId: host.player.id }
  });
  const noPhoto = await call('POST', `/api/rooms/${room3.id}/shots/${called2.room.openPenalties[0].id}`, {
    token: T, body: { took: false }
  });
  ok('refusing without a photo does not get you out of it', noPhoto.httpStatus === 400, noPhoto.error);

  const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const refused = await call('POST', `/api/rooms/${room3.id}/shots/${called2.room.openPenalties[0].id}`, {
    token: T, body: { took: false, dataUrl: PIXEL }
  });
  ok('refusing with a photo clears it', refused.room?.openPenalties.length === 0, refused.error);
  ok('the refusal is counted separately',
    refused.room?.players.find((p) => p.playerId === host.player.id)?.shots.refused === 1);
  ok('and the photo lands in the gallery', refused.room?.photos.some((p) => p.penalty === true));

  await call('POST', `/api/rooms/${room3.id}/cashout`, { token: T, body: { amount: 0 } });
  await call('POST', `/api/rooms/${room3.id}/end`, { token: T, body: { force: true } });
  const shotCard = await call('GET', `/api/players/${host.player.id}/card`, { token: T });
  ok('shots carry into lifetime stats', shotCard.stats?.shotsTaken >= 1 && shotCard.stats?.shotsRefused >= 1,
    `${shotCard.stats?.shotsTaken} taken / ${shotCard.stats?.shotsRefused} refused`);

  const offTable = await call('PATCH', `/api/rooms/${room2.id}`, {
    token: T, body: { config: { shotsEnabled: false, shotName: 'Penalty' } }
  });
  ok('a table can rename it', offTable.room?.config.shotName === 'Penalty', offTable.error);
  const blocked = await call('POST', `/api/rooms/${room2.id}/shots`, { token: T, body: { playerId: host.player.id } });
  ok('or switch it off entirely', blocked.httpStatus === 400, blocked.error);

  console.log('\nBackup');
  const backup = await fetch(`${base}/api/admin/backup.zip`, { headers: { Authorization: `Bearer ${T}` } });
  const zipBuf = Buffer.from(await backup.arrayBuffer());
  ok('backup downloads', backup.status === 200 && zipBuf.length > 200, `${zipBuf.length} bytes`);
  ok('it is a real zip', zipBuf.slice(0, 2).toString() === 'PK');
  ok('it is offered as a file', /attachment; filename=/.test(backup.headers.get('content-disposition') || ''));
  const playerBackup = await fetch(`${base}/api/admin/backup.zip`, { headers: { Authorization: `Bearer ${guests.sam.token}` } });
  ok('a plain player cannot download everyone’s data', playerBackup.status === 403);

  console.log('\nGuessing protection');
  const pinTarget = guests.dev.player.id;
  await call('POST', '/api/auth/set-pin', { token: guests.dev.token, body: { pin: '4821', password: 'password1' } });
  let blockedAt = null;
  for (let i = 0; i < 12; i += 1) {
    const r = await call('POST', '/api/auth/pin', { body: { playerId: pinTarget, pin: '0000' } });
    if (r.httpStatus === 429) { blockedAt = i + 1; break; }
  }
  ok('PIN guessing gets shut down', blockedAt !== null, blockedAt ? `after ${blockedAt} tries` : 'never blocked');
  ok('it says how long to wait', /Wait \d+ (second|minute)/.test(
    (await call('POST', '/api/auth/pin', { body: { playerId: pinTarget, pin: '0000' } })).error || ''));
  const rightPin = await call('POST', '/api/auth/pin', { body: { playerId: pinTarget, pin: '4821' } });
  ok('and the real PIN is refused while locked out, not let through', rightPin.httpStatus === 429, rightPin.error);

  let loginBlocked = null;
  for (let i = 0; i < 12; i += 1) {
    const r = await call('POST', '/api/auth/login', { body: { username: 'sam', password: 'wrong' } });
    if (r.httpStatus === 429) { loginBlocked = i + 1; break; }
  }
  ok('password guessing gets shut down too', loginBlocked !== null, loginBlocked ? `after ${loginBlocked} tries` : 'never');
  const other = await call('POST', '/api/auth/login', { body: { username: 'host', password: 'password1' } });
  ok('locking one account does not lock a different one', !!other.token, other.error);

  console.log('\nSign-ins survive a restart');
  const authMod = require('../src/auth');
  const liveToken = other.token;
  ok('the token works now', (await call('GET', '/api/auth/me', { token: liveToken })).httpStatus === 200);
  await new Promise((r) => setTimeout(r, 400)); // the write is debounced
  const stored = db.tokens.find((t) => t.playerId === host.player.id);
  ok('it was written to disk', !!stored, `${db.tokens.length} on file`);
  ok('only a hash is stored, never the token itself',
    !!stored && stored.hash !== liveToken && /^[a-f0-9]{64}$/.test(stored.hash));
  // Wipe the in-memory table and rebuild it from disk, which is what a restart does.
  authMod.sessions.clear();
  ok('memory is empty after the wipe', authMod.sessions.size === 0);
  for (const rec of db.tokens) {
    authMod.sessions.set(rec.hash, { playerId: rec.playerId, created: rec.created, lastSeen: rec.lastSeen });
  }
  ok('the same token still works afterwards',
    (await call('GET', '/api/auth/me', { token: liveToken })).httpStatus === 200);

  console.log('\nReopening a night that was closed too early');
  const room4 = (await call('POST', '/api/rooms', { token: T, body: { name: 'Miscount' } })).room;
  await call('POST', `/api/rooms/${room4.id}/join`, { token: guests.sam.token, body: {} });
  await call('POST', `/api/rooms/${room4.id}/start`, { token: T });
  await call('POST', `/api/rooms/${room4.id}/buyin`, { token: T, body: { amount: 20 } });
  await call('POST', `/api/rooms/${room4.id}/buyin`, { token: T, body: { playerId: guests.sam.player.id, amount: 20, funding: 'credit' } });
  // Sam is cashed out $10 short by mistake.
  await call('POST', `/api/rooms/${room4.id}/cashout`, { token: T, body: { amount: 30 } });
  await call('POST', `/api/rooms/${room4.id}/cashout`, { token: T, body: { playerId: guests.sam.player.id, amount: 10 } });
  await call('POST', `/api/rooms/${room4.id}/end`, { token: T, body: {} });

  const beforeStats = await call('GET', `/api/players/${guests.sam.player.id}/card`, { token: T });
  const nightsBefore = beforeStats.stats.sessions;
  const owed = async () => {
    const rows = (await call('GET', '/api/admin/balances', { token: T })).balances
      .filter((b) => (b.from === guests.sam.player.id && b.to === host.player.id)
        || (b.from === host.player.id && b.to === guests.sam.player.id));
    return rows.reduce((n, b) => n + (b.from === guests.sam.player.id ? b.amount : -b.amount), 0);
  };
  const balBefore = await owed();
  ok('the night counted and left a debt behind', nightsBefore >= 1 && balBefore >= 20,
    `${nightsBefore} nights, sam owes ${balBefore}`);

  const reopened = await call('POST', `/api/rooms/${room4.id}/reopen`, { token: T, body: { reason: 'counted short' } });
  ok('it reopens', reopened.room?.status === 'active', reopened.error);
  const afterStats = await call('GET', `/api/players/${guests.sam.player.id}/card`, { token: T });
  ok('the night comes back off lifetime stats', afterStats.stats.sessions === nightsBefore - 1,
    `${nightsBefore} -> ${afterStats.stats.sessions}`);
  const balAfter = await owed();
  ok('and the debt it created is taken back off', Math.abs(balAfter - (balBefore - 20)) < 0.01,
    `${balBefore} -> ${balAfter}`);

  // Fix the miscount and close again.
  const fixed = (await call('GET', `/api/rooms/${room4.id}`, { token: T })).room;
  for (const e of fixed.ledger.filter((x) => x.type === 'cashout')) {
    await call('POST', `/api/rooms/${room4.id}/ledger/${e.id}/void`, { token: T });
  }
  await call('POST', `/api/rooms/${room4.id}/cashout`, { token: T, body: { amount: 20 } });
  await call('POST', `/api/rooms/${room4.id}/cashout`, { token: T, body: { playerId: guests.sam.player.id, amount: 20 } });
  const settleFixed = await call('GET', `/api/rooms/${room4.id}/settlement`, { token: T });
  ok('the corrected night reconciles', Math.abs(settleFixed.pot.chipsInPlay) < 0.01, `${settleFixed.pot.chipsInPlay} left`);
  const reclosed = await call('POST', `/api/rooms/${room4.id}/end`, { token: T, body: {} });
  ok('and it closes again', reclosed.room?.status === 'ended', reclosed.error);
  const finalStats = await call('GET', `/api/players/${guests.sam.player.id}/card`, { token: T });
  ok('counting the night exactly once', finalStats.stats.sessions === nightsBefore,
    `${finalStats.stats.sessions} vs ${nightsBefore}`);

  const twice = await call('POST', `/api/rooms/${room4.id}/reopen`, { token: T, body: {} });
  const thrice = await call('POST', `/api/rooms/${room4.id}/reopen`, { token: T, body: {} });
  ok('reopening twice in a row is refused', thrice.httpStatus === 400, thrice.error);
  await call('POST', `/api/rooms/${room4.id}/end`, { token: T, body: { force: true } });
  void twice;

  const notAdmin3 = await call('POST', `/api/rooms/${room4.id}/reopen`, { token: guests.sam.token, body: {} });
  ok('a plain player cannot reopen a night', notAdmin3.httpStatus === 403);

  console.log('\nDebts do not inflate across nights');
  const owedNow = await owed();
  const room5 = (await call('POST', '/api/rooms', { token: T, body: { name: 'Again' } })).room;
  await call('POST', `/api/rooms/${room5.id}/join`, { token: guests.sam.token, body: {} });
  await call('POST', `/api/rooms/${room5.id}/start`, { token: T });
  // A night where nobody wins or loses anything at all.
  await call('POST', `/api/rooms/${room5.id}/buyin`, { token: T, body: { amount: 20 } });
  await call('POST', `/api/rooms/${room5.id}/buyin`, { token: T, body: { playerId: guests.sam.player.id, amount: 20 } });
  await call('POST', `/api/rooms/${room5.id}/cashout`, { token: T, body: { amount: 20 } });
  await call('POST', `/api/rooms/${room5.id}/cashout`, { token: T, body: { playerId: guests.sam.player.id, amount: 20 } });
  await call('POST', `/api/rooms/${room5.id}/end`, { token: T, body: {} });
  const owedAfterEven = await owed();
  ok('an even night leaves an old debt exactly where it was',
    Math.abs(owedAfterEven - owedNow) < 0.01, `${owedNow} -> ${owedAfterEven}`);

  const room6 = (await call('POST', '/api/rooms', { token: T, body: { name: 'Third' } })).room;
  await call('POST', `/api/rooms/${room6.id}/join`, { token: guests.sam.token, body: {} });
  await call('POST', `/api/rooms/${room6.id}/start`, { token: T });
  await call('POST', `/api/rooms/${room6.id}/buyin`, { token: T, body: { amount: 20 } });
  await call('POST', `/api/rooms/${room6.id}/buyin`, { token: T, body: { playerId: guests.sam.player.id, amount: 20, funding: 'credit' } });
  await call('POST', `/api/rooms/${room6.id}/cashout`, { token: T, body: { amount: 40 } });
  await call('POST', `/api/rooms/${room6.id}/cashout`, { token: T, body: { playerId: guests.sam.player.id, amount: 0 } });
  await call('POST', `/api/rooms/${room6.id}/end`, { token: T, body: {} });
  const owedAfterLoss = await owed();
  ok('and a losing night adds only what was lost that night',
    Math.abs(owedAfterLoss - (owedAfterEven + 20)) < 0.01,
    `${owedAfterEven} + 20 expected, got ${owedAfterLoss}`);

  const lateCash = await call('POST', `/api/rooms/${room4.id}/cashout`, { token: T, body: { amount: 5 } });
  ok('a closed night refuses new cash-outs', lateCash.httpStatus === 400, lateCash.error);
  const lateSpend = await call('POST', `/api/rooms/${room4.id}/expenses`, { token: T, body: { label: 'Beer', amount: 5 } });
  ok('and refuses new spending', lateSpend.httpStatus === 400, lateSpend.error);

  console.log('\nTime at the table is counted per person');
  const roomT = (await call('POST', '/api/rooms', { token: T, body: { name: 'Clock' } })).room;
  await call('POST', `/api/rooms/${roomT.id}/join`, { token: guests.sam.token, body: {} });
  await call('POST', `/api/rooms/${roomT.id}/start`, { token: T });
  await new Promise((r) => setTimeout(r, 1200));
  // Sam leaves early; the host stays.
  await call('POST', `/api/rooms/${roomT.id}/leave`, { token: guests.sam.token });
  await new Promise((r) => setTimeout(r, 1200));

  const clockRoom = (await call('GET', `/api/rooms/${roomT.id}`, { token: T })).room;
  const hostSeat = clockRoom.players.find((p) => p.playerId === host.player.id);
  const samSeat = clockRoom.players.find((p) => p.playerId === guests.sam.player.id);
  ok('the person who stayed has more time than the one who left',
    hostSeat.seatedMs > samSeat.seatedMs + 800,
    `host ${hostSeat.seatedMs}ms vs sam ${samSeat.seatedMs}ms`);
  ok('the one who left has stopped accruing', samSeat.seatedMs < 2000, `${samSeat.seatedMs}ms`);
  ok('and it is not simply the whole night for everyone',
    Math.abs(hostSeat.seatedMs - samSeat.seatedMs) > 500);

  await call('POST', `/api/rooms/${roomT.id}/buyin`, { token: T, body: { amount: 20 } });
  await call('POST', `/api/rooms/${roomT.id}/cashout`, { token: T, body: { amount: 20 } });
  await call('POST', `/api/rooms/${roomT.id}/end`, { token: T, body: { force: true } });
  const archived = db.sessions.find((x) => x.id === roomT.id);
  ok('it is written into the archived night',
    archived.positions.every((p) => typeof p.seatedMs === 'number'),
    archived.positions.map((p) => p.seatedMs).join(', '));
  const hostPos = archived.positions.find((p) => p.playerId === host.player.id);
  const samPos = archived.positions.find((p) => p.playerId === guests.sam.player.id);
  ok('with the difference preserved', hostPos.seatedMs > samPos.seatedMs);

  console.log('\nUndoing a settled balance');
  const settleTarget = guests.sam.player.id;
  const beforeUndo = (await call('GET', `/api/players/${settleTarget}/card`, { token: T })).between;
  ok('there is a balance to settle', Math.abs(beforeUndo || 0) > 0, String(beforeUndo));
  const settled = await call('POST', '/api/players/me/settle-balance', { token: T, body: { other: settleTarget } });
  ok('settling clears it', Math.abs(settled.between || 0) < 0.01, String(settled.between));
  ok('and hands back something to undo with', !!settled.undoId);
  const undone = await call('POST', '/api/players/me/settle-balance/undo', { token: T, body: { undoId: settled.undoId } });
  ok('undo puts the money back exactly', Math.abs((undone.between || 0) - beforeUndo) < 0.01,
    `${beforeUndo} -> ${undone.between}`);
  const twiceUndone = await call('POST', '/api/players/me/settle-balance/undo', { token: T, body: { undoId: settled.undoId } });
  ok('undoing the same one twice is refused', twiceUndone.httpStatus === 400, twiceUndone.error);
  const settled2 = await call('POST', '/api/players/me/settle-balance', { token: T, body: { other: settleTarget } });
  const notYours2 = await call('POST', '/api/players/me/settle-balance/undo', {
    token: guests.dev.token, body: { undoId: settled2.undoId }
  });
  ok('and only the person who settled it can undo it', notYours2.httpStatus === 403);

  console.log('\nThings that were taken out');
  const gone = await call('POST', `/api/rooms/${room4.id}/transfer`, {
    token: T, body: { from: host.player.id, to: guests.sam.player.id, amount: 5 }
  });
  ok('there is no separate cash-transfer route any more', gone.httpStatus === 404, `HTTP ${gone.httpStatus}`);
  const boot2 = await call('GET', '/api/bootstrap');
  ok('the game list is down to the ones actually played',
    !boot2.games.tournament && !boot2.games.side_game && !!boot2.games.texas_holdem,
    Object.keys(boot2.games).join(', '));
  const meNow = await call('GET', '/api/auth/me', { token: T });
  ok('the unused theme setting is gone', meNow.player.settings.theme === undefined,
    JSON.stringify(meNow.player.settings));

  console.log('\nThe poker admin owns the name and the mark');
  const renamed = await call('PATCH', '/api/admin/settings', { token: T, body: { siteName: 'Scammer Casino' } });
  ok('the name can be changed', renamed.settings?.siteName === 'Scammer Casino', renamed.error);
  const bootNamed = await call('GET', '/api/bootstrap');
  ok('and it reaches the app', bootNamed.siteName === 'Scammer Casino');

  const manifest = await (await fetch(`${base}/manifest.json`)).json();
  ok('the home-screen name follows it too', manifest.name === 'Scammer Casino', manifest.name);
  ok('the manifest points at the served mark', manifest.icons?.[0]?.src === '/brand/icon');
  ok('the short name breaks on a word, not mid-syllable',
    manifest.short_name === 'Scammer Casino', manifest.short_name);

  const defaultIcon = await fetch(`${base}/brand/icon`);
  ok('there is a mark before anyone uploads one', defaultIcon.status === 200);
  ok('and it is the bundled one', /svg/.test(defaultIcon.headers.get('content-type') || ''),
    defaultIcon.headers.get('content-type'));
  ok('the app reports no custom logo yet', bootNamed.hasCustomLogo === false);

  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const upped = await call('POST', '/api/admin/brand', { token: T, body: { dataUrl: PNG } });
  ok('a poker admin can upload a logo', !!upped.logo, upped.error);
  const customIcon = await fetch(`${base}/brand/icon`);
  ok('the served mark switches to it', /png/.test(customIcon.headers.get('content-type') || ''),
    customIcon.headers.get('content-type'));
  const manifest2 = await (await fetch(`${base}/manifest.json`)).json();
  ok('and the home-screen icon type follows', manifest2.icons[0].type === 'image/png', manifest2.icons[0].type);
  ok('the app knows a custom logo is set', (await call('GET', '/api/bootstrap')).hasCustomLogo === true);

  const notAdminBrand = await call('POST', '/api/admin/brand', { token: guests.sam.token, body: { dataUrl: PNG } });
  ok('a plain player cannot change the logo', notAdminBrand.httpStatus === 403);
  const junk = await call('POST', '/api/admin/brand', { token: T, body: { dataUrl: 'not-an-image' } });
  ok('junk is refused with a reason', junk.httpStatus === 400, junk.error);

  const backupNamed = await fetch(`${base}/api/admin/backup.zip`, { headers: { Authorization: `Bearer ${T}` } });
  ok('backups are named after the site', /scammer-casino-backup/.test(backupNamed.headers.get('content-disposition') || ''),
    backupNamed.headers.get('content-disposition'));

  const cleared = await call('DELETE', '/api/admin/brand', { token: T });
  ok('and it can go back to the default', cleared.logo === null);
  ok('the served mark reverts', /svg/.test((await fetch(`${base}/brand/icon`)).headers.get('content-type') || ''));
  await call('PATCH', '/api/admin/settings', { token: T, body: { siteName: 'Poker Hub' } });

  console.log('\nA password is optional');
  const noPw = await call('POST', '/api/auth/signup', { body: { username: 'quinn', displayName: 'Quinn' } });
  ok('you can sign up without one', !!noPw.token, noPw.error);
  ok('and the account knows it has none', noPw.player.hasPassword === false);

  const picked = await call('POST', '/api/auth/pick', { body: { playerId: noPw.player.id } });
  ok('tapping the name signs you in', !!picked.token, picked.error);
  ok('which is a real session', (await call('GET', '/api/auth/me', { token: picked.token })).httpStatus === 200);

  const faces = await call('GET', '/api/auth/faces');
  const quinnFace = faces.players.find((f) => f.id === noPw.player.id);
  ok('they show on the tap-a-name screen', !!quinnFace);
  ok('flagged as not needing a PIN', quinnFace.needsPin === false);

  const blankLogin = await call('POST', '/api/auth/login', { body: { username: 'quinn' } });
  ok('the username form works with the password left blank', !!blankLogin.token, blankLogin.error);

  const pwUser = await call('POST', '/api/auth/pick', { body: { playerId: host.player.id } });
  ok('but tapping cannot bypass an account that has one', pwUser.httpStatus === 401, pwUser.error);
  const stillNeeded = await call('POST', '/api/auth/login', { body: { username: 'host' } });
  ok('and a blank password is still refused there', stillNeeded.httpStatus === 401, stillNeeded.error);

  const tooShort = await call('POST', '/api/auth/signup', { body: { username: 'shorty', password: '12' } });
  ok('a password you do set still has to be decent', tooShort.httpStatus === 400, tooShort.error);

  console.log('\nAdding and removing a password afterwards');
  const added = await call('POST', '/api/auth/password', { token: picked.token, body: { next: 'brandnew1' } });
  ok('an account with none can set one without confirming anything', added.hasPassword === true, added.error);
  ok('and then it is required', (await call('POST', '/api/auth/pick', { body: { playerId: noPw.player.id } })).httpStatus === 401);
  const withPw = await call('POST', '/api/auth/login', { body: { username: 'quinn', password: 'brandnew1' } });
  ok('the new password works', !!withPw.token, withPw.error);

  const removed = await call('POST', '/api/auth/password', {
    token: withPw.token, body: { current: 'brandnew1', next: '' }
  });
  ok('and it can be taken off again', removed.hasPassword === false, removed.error);
  ok('back to tapping the name', !!(await call('POST', '/api/auth/pick', { body: { playerId: noPw.player.id } })).token);

  const wrongCurrent = await call('POST', '/api/auth/login', { body: { username: 'quinn', password: 'anything' } });
  ok('a passwordless account ignores a password that was sent anyway', !!wrongCurrent.token);

  console.log('\nPasswordless accounts from the admin area');
  const madeBlank = await call('POST', '/api/admin/players', {
    token: T, body: { username: 'blankie', displayName: 'Blankie' }
  });
  ok('a poker admin can create one with no password', !!madeBlank.player, madeBlank.error);
  const list = await call('GET', '/api/admin/players', { token: T });
  const row = list.players.find((x) => x.username === 'blankie');
  ok('and the list says so plainly', row.hasPassword === false);

  const strip = await call('POST', `/api/admin/players/${row.id}/password`, { token: T, body: { password: '' } });
  ok('an admin can strip a password off', strip.hasPassword === false, strip.error);
  const reAdd = await call('POST', `/api/admin/players/${row.id}/password`, { token: T, body: { password: 'setagain1' } });
  ok('and put one back', reAdd.hasPassword === true, reAdd.error);

  console.log('\nPINs still work without a password behind them');
  const pinless = await call('POST', '/api/auth/signup', { body: { username: 'pinonly', displayName: 'Pin Only' } });
  const setPin = await call('POST', '/api/auth/set-pin', { token: pinless.token, body: { pin: '2468' } });
  ok('a PIN can be set with no password to confirm with', setPin.hasPin === true, setPin.error);
  const tapBlocked = await call('POST', '/api/auth/pick', { body: { playerId: pinless.player.id } });
  ok('the PIN then guards the tap', tapBlocked.httpStatus === 401, tapBlocked.error);
  const byPin = await call('POST', '/api/auth/pin', { body: { playerId: pinless.player.id, pin: '2468' } });
  ok('and entering it gets you in', !!byPin.token, byPin.error);

  server.close();
  console.log(`\n${fails === 0 ? 'All API checks passed.' : `${fails} check(s) failed.`}\n`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
