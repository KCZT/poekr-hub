'use strict';
const { db } = require('./store');
const { round } = require('./ledger');

/**
 * Lifetime numbers are derived from archived sessions, then nudged by any
 * manual corrections a poker admin has made. Deriving rather than storing means
 * an admin edit is always visible as an edit, never silently baked in.
 */
function lifetime(playerId) {
  const base = {
    sessions: 0, net: 0, buyIn: 0, cashOut: 0, wins: 0, losses: 0, evens: 0,
    biggestWin: 0, biggestLoss: 0, hours: 0, shortBuys: 0, rebuys: 0,
    shotsTaken: 0, shotsRefused: 0,
    gamesPlayed: {}, byGame: {}, streak: 0, bestStreak: 0, lastPlayed: null
  };
  const history = [];

  const played = db.sessions
    .filter((s) => s.positions?.some((p) => p.playerId === playerId))
    .sort((a, b) => a.endedAt - b.endedAt);

  let streak = 0;
  for (const s of played) {
    const pos = s.positions.find((p) => p.playerId === playerId);
    base.sessions += 1;
    base.net += pos.result;
    base.buyIn += pos.buyIn;
    base.cashOut += pos.cashOut;
    base.shortBuys += pos.shortBuys || 0;
    base.rebuys += pos.rebuys || 0;
    base.shotsTaken += pos.shotsTaken || 0;
    base.shotsRefused += pos.shotsRefused || 0;
    // Nights recorded before per-player time existed only have the room's own
    // length to go on, which over-credits anyone who did not stay the whole way.
    base.hours += (pos.seatedMs ?? s.durationMs ?? 0) / 3600000;
    base.lastPlayed = s.endedAt;
    if (pos.result > 0) { base.wins += 1; streak = streak > 0 ? streak + 1 : 1; }
    else if (pos.result < 0) { base.losses += 1; streak = streak < 0 ? streak - 1 : -1; }
    else { base.evens += 1; streak = 0; }
    base.bestStreak = Math.max(base.bestStreak, streak);
    base.biggestWin = Math.max(base.biggestWin, pos.result);
    base.biggestLoss = Math.min(base.biggestLoss, pos.result);
    for (const g of s.games || []) {
      base.gamesPlayed[g] = (base.gamesPlayed[g] || 0) + 1;
      const bg = base.byGame[g] || { sessions: 0, net: 0 };
      bg.sessions += 1;
      bg.net = round(bg.net + (pos.byGame?.[g] ?? 0));
      base.byGame[g] = bg;
    }
    history.push({ at: s.endedAt, name: s.name, result: pos.result, games: s.games || [] });
  }
  base.streak = streak;

  const player = db.players.find((p) => p.id === playerId);
  const adjustments = player?.statAdjustments || [];
  for (const a of adjustments) {
    if (typeof base[a.field] === 'number') base[a.field] = round(base[a.field] + a.delta);
  }

  base.net = round(base.net);
  base.buyIn = round(base.buyIn);
  base.cashOut = round(base.cashOut);
  base.hours = round(base.hours);
  base.winRate = base.sessions ? Math.round((base.wins / base.sessions) * 100) : 0;
  base.avgBuyIn = base.sessions ? round(base.buyIn / base.sessions) : 0;
  base.perSession = base.sessions ? round(base.net / base.sessions) : 0;
  base.roi = base.buyIn ? Math.round((base.net / base.buyIn) * 100) : 0;
  base.hourly = base.hours >= 0.5 ? round(base.net / base.hours) : null;
  base.adjusted = adjustments.length > 0;
  base.history = history.slice(-40);
  base.achievements = achievements(base, history);
  return base;
}

const BADGES = [
  { id: 'first_night', name: 'First night', hint: 'Played a session', test: (s) => s.sessions >= 1 },
  { id: 'regular', name: 'Regular', hint: '10 sessions', test: (s) => s.sessions >= 10 },
  { id: 'fixture', name: 'Fixture', hint: '50 sessions', test: (s) => s.sessions >= 50 },
  { id: 'up_overall', name: 'In the black', hint: 'Lifetime net above zero', test: (s) => s.net > 0 },
  { id: 'century', name: 'Century', hint: 'Won 100 in one night', test: (s) => s.biggestWin >= 100 },
  { id: 'heater', name: 'On a heater', hint: 'Three winning nights in a row', test: (s) => s.bestStreak >= 3 },
  { id: 'ironman', name: 'Iron man', hint: '24 hours at the table', test: (s) => s.hours >= 24 },
  { id: 'nit', name: 'Never rebought', hint: '5+ sessions, no rebuys', test: (s) => s.sessions >= 5 && s.rebuys === 0 },
  { id: 'comeback', name: 'Comeback', hint: 'Won after a losing streak', test: (s, h) => {
    for (let i = 3; i < h.length; i++) {
      if (h[i].result > 0 && h[i - 1].result < 0 && h[i - 2].result < 0 && h[i - 3].result < 0) return true;
    }
    return false;
  } },
  { id: 'takes_it', name: 'Takes it', hint: 'Never once refused a shot', test: (s) => s.shotsTaken >= 3 && s.shotsRefused === 0 },
  { id: 'camera_shy', name: 'Photographed', hint: 'Refused five times', test: (s) => s.shotsRefused >= 5 },
  { id: 'dealer_choice', name: 'Dealer’s choice', hint: 'Played three different games', test: (s) => Object.keys(s.gamesPlayed).length >= 3 }
];

function achievements(stats, history) {
  return BADGES.filter((b) => {
    try { return b.test(stats, history); } catch { return false; }
  }).map(({ id, name, hint }) => ({ id, name, hint }));
}

/** How two players have done at the same tables. */
function headToHead(aId, bId) {
  const shared = db.sessions.filter((s) =>
    s.positions?.some((p) => p.playerId === aId) && s.positions?.some((p) => p.playerId === bId));
  let aNet = 0, bNet = 0, aBetter = 0, bBetter = 0;
  for (const s of shared) {
    const a = s.positions.find((p) => p.playerId === aId);
    const b = s.positions.find((p) => p.playerId === bId);
    aNet += a.result; bNet += b.result;
    if (a.result > b.result) aBetter += 1; else if (b.result > a.result) bBetter += 1;
  }
  return {
    sessions: shared.length,
    aNet: round(aNet), bNet: round(bNet),
    aBetter, bBetter
  };
}

/** Standing balance between two people, carried across nights. */
function balanceBetween(aId, bId) {
  const rec = db.balances.find((b) =>
    (b.from === aId && b.to === bId) || (b.from === bId && b.to === aId));
  if (!rec) return 0;
  return rec.from === aId ? -rec.amount : rec.amount; // negative => a owes b
}

function adjustBalance(fromId, toId, amount) {
  if (Math.abs(amount) < 0.01) return;
  let rec = db.balances.find((b) =>
    (b.from === fromId && b.to === toId) || (b.from === toId && b.to === fromId));
  if (!rec) {
    rec = { from: fromId, to: toId, amount: 0, updatedAt: Date.now() };
    db.balances.push(rec);
  }
  rec.amount = round(rec.amount + (rec.from === fromId ? amount : -amount));
  rec.updatedAt = Date.now();
  if (rec.amount < 0) {
    const t = rec.from; rec.from = rec.to; rec.to = t; rec.amount = round(-rec.amount);
  }
  if (rec.amount < 0.01) {
    const i = db.balances.indexOf(rec);
    if (i >= 0) db.balances.splice(i, 1);
  }
  db.save('balances');
}

function openBalancesFor(playerId) {
  return db.balances
    .filter((b) => b.from === playerId || b.to === playerId)
    .map((b) => ({
      other: b.from === playerId ? b.to : b.from,
      amount: b.from === playerId ? -b.amount : b.amount, // negative => you owe
      updatedAt: b.updatedAt
    }))
    .filter((b) => Math.abs(b.amount) >= 0.01);
}

/** Leaderboard across all archived sessions, filterable by window and game. */
function leaderboard({ since = 0, game = null, metric = 'net' } = {}) {
  const rows = new Map();
  for (const s of db.sessions) {
    if (s.endedAt < since) continue;
    if (game && !(s.games || []).includes(game)) continue;
    for (const p of s.positions || []) {
      const r = rows.get(p.playerId) || {
        playerId: p.playerId, net: 0, sessions: 0, wins: 0, buyIn: 0, best: 0, hours: 0
      };
      r.net = round(r.net + p.result);
      r.buyIn = round(r.buyIn + p.buyIn);
      r.sessions += 1;
      r.hours = round(r.hours + (p.seatedMs ?? s.durationMs ?? 0) / 3600000);
      if (p.result > 0) r.wins += 1;
      r.best = Math.max(r.best, p.result);
      rows.set(p.playerId, r);
    }
  }
  const list = [...rows.values()].map((r) => ({
    ...r,
    winRate: r.sessions ? Math.round((r.wins / r.sessions) * 100) : 0,
    perSession: r.sessions ? round(r.net / r.sessions) : 0,
    roi: r.buyIn ? Math.round((r.net / r.buyIn) * 100) : 0,
    hourly: r.hours >= 0.5 ? round(r.net / r.hours) : 0
  }));
  const key = ['net', 'winRate', 'perSession', 'roi', 'sessions', 'best', 'hourly'].includes(metric) ? metric : 'net';
  return list.sort((a, b) => b[key] - a[key]);
}

module.exports = { lifetime, headToHead, balanceBetween, adjustBalance, openBalancesFor, leaderboard };
