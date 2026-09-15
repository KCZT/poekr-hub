'use strict';
const express = require('express');
const { db, logAudit, id } = require('../store');
const A = require('../auth');
const media = require('../media');
const stats = require('../stats');
const G = require('../games');

const sounds = express.Router();
sounds.use(A.attach);

const SLOTS = [
  { id: 'buyin', label: 'Someone buys in' },
  { id: 'cashout', label: 'Someone cashes out' },
  { id: 'request', label: 'A request needs approval' },
  { id: 'game_start', label: 'Cards in the air' },
  { id: 'game_change', label: 'Game switches' },
  { id: 'game_end', label: 'Game ends' },
  { id: 'announce', label: 'Someone calls out' },
  { id: 'join', label: 'Someone sits down' },
  { id: 'settle', label: 'Settling up' },
  { id: 'shot', label: 'A shot gets called' },
  { id: 'shot_taken', label: 'They take it' },
  { id: 'shot_refused', label: 'They refuse it' }
];

sounds.get('/', (_req, res) => {
  res.json({
    sounds: db.sounds.map((s) => ({
      ...s, byName: db.players.find((p) => p.id === s.by)?.displayName || 'Someone'
    })),
    slots: SLOTS
  });
});

sounds.post('/', A.requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Name the sound so people can find it.' });
  try {
    const saved = media.saveDataUrl('sounds', req.body?.dataUrl);
    const sound = {
      id: id('snd'), name, url: saved.url, bytes: saved.bytes,
      by: req.player.id, ts: Date.now(), tag: String(req.body?.tag || '').slice(0, 20)
    };
    db.sounds.push(sound);
    db.save('sounds');
    res.json({ sound });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

sounds.delete('/:id', A.requireAuth, (req, res) => {
  const i = db.sounds.findIndex((s) => s.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'That sound is gone.' });
  const s = db.sounds[i];
  if (s.by !== req.player.id && req.player.role !== 'site_admin') {
    return res.status(403).json({ error: 'You can only remove sounds you added.' });
  }
  media.remove(s.url);
  db.sounds.splice(i, 1);
  for (const r of db.rooms) {
    for (const [k, v] of Object.entries(r.sounds || {})) if (v === s.id) delete r.sounds[k];
  }
  for (const p of db.players) if (p.walkupSoundId === s.id) p.walkupSoundId = null;
  db.save('sounds'); db.save('rooms'); db.save('players');
  res.json({ ok: true });
});

// ── Public, read-only sharing ────────────────────────────────────────────────

const share = express.Router();

function slim(p) {
  if (!p) return null;
  return { id: p.id, displayName: p.displayName, avatar: p.avatar, accent: p.accent, suit: p.suit };
}

/** A room's live or final leaderboard, no sign-in needed. */
share.get('/room/:token', (req, res) => {
  const room = db.rooms.find((r) => r.shareToken === req.params.token);
  const session = db.sessions.find((s) => s.shareToken === req.params.token);
  if (!room && !session) return res.status(404).json({ error: 'This link is no longer live.' });

  if (room) {
    const L = require('../ledger');
    const pos = L.positions(room);
    return res.json({
      kind: 'room',
      name: room.name,
      status: room.status,
      game: G.label(room.segments.find((s) => !s.endedAt)?.game || room.segments.at(-1)?.game),
      games: [...new Set(room.segments.map((s) => G.label(s.game)))],
      currency: room.config.currency,
      startedAt: room.startedAt,
      pot: L.potState(room),
      rows: [...pos.values()]
        .map((m) => ({ ...slim(db.players.find((p) => p.id === m.playerId)), result: m.result, buyIn: m.buyIn, cashOut: m.cashOut }))
        .sort((a, b) => b.result - a.result)
    });
  }
  return res.json({
    kind: 'session',
    name: session.name,
    status: 'ended',
    games: (session.games || []).map(G.label),
    currency: '$',
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    rows: session.positions
      .map((m) => ({ ...slim(db.players.find((p) => p.id === m.playerId)), result: m.result, buyIn: m.buyIn, cashOut: m.cashOut }))
      .sort((a, b) => b.result - a.result)
  });
});

/** One person's stat card, no sign-in needed. */
share.get('/player/:token', (req, res) => {
  const p = db.players.find((x) => x.shareToken === req.params.token);
  if (!p) return res.status(404).json({ error: 'This link is no longer live.' });
  const life = stats.lifetime(p.id);
  res.json({
    kind: 'player',
    player: { ...slim(p), bio: p.bio },
    stats: {
      sessions: life.sessions, net: life.net, winRate: life.winRate, wins: life.wins,
      losses: life.losses, biggestWin: life.biggestWin, biggestLoss: life.biggestLoss,
      perSession: life.perSession, roi: life.roi, hours: life.hours, streak: life.streak,
      achievements: life.achievements, byGame: life.byGame,
      history: life.history.slice(-12)
    },
    currency: db.settings.currency
  });
});

/** The all-time table, optionally scoped to a window or one game. */
share.get('/leaderboard/:token', (req, res) => {
  if (req.params.token !== db.settings.leaderboardToken) {
    return res.status(404).json({ error: 'This link is no longer live.' });
  }
  const days = Number(req.query.days || 0);
  const rows = stats.leaderboard({
    since: days > 0 ? Date.now() - days * 864e5 : 0,
    game: req.query.game || null,
    metric: req.query.metric || 'net'
  });
  res.json({
    kind: 'leaderboard',
    name: `${db.settings.siteName} all time`,
    currency: db.settings.currency,
    // Same row shape as a room's leaderboard so the share page renders one way.
    rows: rows.map((r) => ({
      ...slim(db.players.find((p) => p.id === r.playerId)),
      ...r,
      result: r.net,
      cashOut: Math.round((r.buyIn + r.net) * 100) / 100,
      nights: r.sessions
    }))
  });
});

const leaderboardShare = express.Router();
leaderboardShare.use(A.attach, A.requireSiteAdmin);
leaderboardShare.post('/', (req, res) => {
  const crypto = require('crypto');
  db.settings.leaderboardToken = req.body?.enabled === false
    ? null : (db.settings.leaderboardToken || crypto.randomBytes(9).toString('hex'));
  db.save('settings');
  logAudit(req.player.id, 'admin.leaderboard_share', { enabled: !!db.settings.leaderboardToken });
  res.json({ token: db.settings.leaderboardToken });
});

module.exports = { sounds, share, leaderboardShare };
