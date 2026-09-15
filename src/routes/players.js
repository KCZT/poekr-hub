'use strict';
const express = require('express');
const crypto = require('crypto');
const { db, logAudit } = require('../store');
const A = require('../auth');
const media = require('../media');
const stats = require('../stats');
const { publicPlayer } = require('./auth');

const router = express.Router();
router.use(A.attach);

router.get('/', A.requireAuthToRead, (_req, res) => {
  res.json({ players: db.players.filter((p) => !p.disabled).map((p) => publicPlayer(p)) });
});

/** Everything the profile card shows. */
router.get('/:id/card', A.requireAuthToRead, (req, res) => {
  const p = db.players.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'No such player.' });

  const card = {
    player: publicPlayer(p, req.player?.id === p.id),
    stats: stats.lifetime(p.id),
    balances: stats.openBalancesFor(p.id).map((b) => ({
      ...b,
      otherName: db.players.find((x) => x.id === b.other)?.displayName || 'Someone'
    }))
  };
  if (req.player && req.player.id !== p.id) {
    card.headToHead = stats.headToHead(req.player.id, p.id);
    card.between = stats.balanceBetween(req.player.id, p.id); // <0 => you owe them
  }
  res.json(card);
});

router.patch('/me', A.requireAuth, (req, res) => {
  const { displayName, bio, accent, payHandles, settings, walkupSoundId } = req.body || {};
  const p = req.player;
  if (displayName !== undefined) {
    const n = String(displayName).trim().slice(0, 32);
    if (!n) return res.status(400).json({ error: 'Pick a display name.' });
    p.displayName = n;
  }
  if (bio !== undefined) p.bio = String(bio).slice(0, 140);
  if (accent !== undefined && /^#[0-9a-f]{6}$/i.test(accent)) p.accent = accent;
  if (payHandles && typeof payHandles === 'object') {
    p.payHandles = {
      venmo: String(payHandles.venmo || '').slice(0, 40),
      cashapp: String(payHandles.cashapp || '').slice(0, 40),
      paypal: String(payHandles.paypal || '').slice(0, 60)
    };
  }
  if (settings && typeof settings === 'object') {
    p.settings = { ...p.settings, ...settings };
  }
  if (walkupSoundId !== undefined) p.walkupSoundId = walkupSoundId || null;
  db.save('players');
  res.json({ player: publicPlayer(p, true) });
});

router.post('/me/avatar', A.requireAuth, (req, res) => {
  try {
    const saved = media.saveDataUrl('avatars', req.body?.dataUrl);
    if (req.player.avatar) media.remove(req.player.avatar);
    req.player.avatar = saved.url;
    db.save('players');
    res.json({ avatar: saved.url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/me/avatar', A.requireAuth, (req, res) => {
  if (req.player.avatar) media.remove(req.player.avatar);
  req.player.avatar = null;
  db.save('players');
  res.json({ ok: true });
});

/** Turn the personal stat card into a link anyone can open. */
router.post('/me/share', A.requireAuth, (req, res) => {
  const on = req.body?.enabled !== false;
  if (on) {
    req.player.shareToken = req.player.shareToken || crypto.randomBytes(9).toString('hex');
  } else {
    req.player.shareToken = null;
  }
  db.save('players');
  res.json({ shareToken: req.player.shareToken });
});

/** Mark a standing debt as paid off, from either side. */
router.post('/me/settle-balance', A.requireAuth, (req, res) => {
  const { other, amount } = req.body || {};
  const target = db.players.find((p) => p.id === other);
  if (!target) return res.status(404).json({ error: 'No such player.' });
  const current = stats.balanceBetween(req.player.id, other);
  const amt = amount === undefined ? Math.abs(current) : Number(amount);
  if (!(amt > 0)) return res.status(400).json({ error: 'Enter an amount above zero.' });
  const iPaid = current < 0;
  if (iPaid) stats.adjustBalance(req.player.id, other, -amt); // you paid them
  else stats.adjustBalance(other, req.player.id, -amt);
  const entry = logAudit(req.player.id, 'balance.settled', { other, amount: amt, iPaid });
  // Wiping money in one tap needs a way back that does not involve an admin.
  res.json({ between: stats.balanceBetween(req.player.id, other), undoId: entry.id });
});

router.post('/me/settle-balance/undo', A.requireAuth, (req, res) => {
  const entry = db.audit.find((a) => a.id === req.body?.undoId);
  if (!entry || entry.action !== 'balance.settled') {
    return res.status(404).json({ error: 'Nothing to put back.' });
  }
  if (entry.actorId !== req.player.id) {
    return res.status(403).json({ error: 'Only the person who settled it can put it back.' });
  }
  if (entry.detail.undone) return res.status(400).json({ error: 'That one is already back.' });

  const { other, amount, iPaid } = entry.detail;
  if (iPaid) stats.adjustBalance(req.player.id, other, amount);
  else stats.adjustBalance(other, req.player.id, amount);
  entry.detail.undone = true;
  db.save('audit');
  logAudit(req.player.id, 'balance.settle_undone', { other, amount });
  res.json({ between: stats.balanceBetween(req.player.id, other) });
});

router.get('/leaderboard', A.requireAuthToRead, (req, res) => {
  const days = Number(req.query.days || 0);
  const since = days > 0 ? Date.now() - days * 864e5 : 0;
  const rows = stats.leaderboard({
    since, game: req.query.game || null, metric: req.query.metric || 'net'
  });
  res.json({
    rows: rows.map((r) => {
      const p = db.players.find((x) => x.id === r.playerId);
      return { ...r, displayName: p?.displayName || 'Departed player', avatar: p?.avatar, accent: p?.accent, suit: p?.suit };
    })
  });
});

module.exports = router;
