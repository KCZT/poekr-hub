'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const zip = require('../zip');
const config = require('../config');
const { db, logAudit, id } = require('../store');
const A = require('../auth');
const stats = require('../stats');
const media = require('../media');
const { publicPlayer } = require('./auth');

const router = express.Router();
router.use(A.attach, A.requireSiteAdmin);

const EDITABLE = ['net', 'sessions', 'wins', 'losses', 'buyIn', 'cashOut', 'hours', 'biggestWin', 'biggestLoss', 'rebuys', 'shortBuys'];

router.get('/overview', (_req, res) => {
  const live = db.rooms.filter((r) => r.status !== 'ended');
  res.json({
    settings: db.settings,
    counts: {
      players: db.players.filter((p) => !p.disabled).length,
      disabled: db.players.filter((p) => p.disabled).length,
      guests: db.players.filter((p) => p.isGuest).length,
      openRooms: live.length,
      sessions: db.sessions.length,
      openBalances: db.balances.length,
      sounds: db.sounds.length
    },
    rooms: live.map((r) => ({
      id: r.id, code: r.code, name: r.name, status: r.status,
      players: r.players.length, createdAt: r.createdAt
    })),
    recentAudit: db.audit.slice(0, 25).map((a) => ({
      ...a, actorName: db.players.find((p) => p.id === a.actorId)?.displayName || 'System'
    }))
  });
});

router.get('/players', (_req, res) => {
  res.json({
    players: db.players.map((p) => ({
      ...publicPlayer(p),
      isGuest: !!p.isGuest,
      hasPin: !!p.pinHash,
      hasPassword: !!p.passwordHash,
      adjustments: (p.statAdjustments || []).length,
      lifetime: stats.lifetime(p.id)
    }))
  });
});

router.post('/players', (req, res) => {
  const { username, displayName, password, role } = req.body || {};
  const uname = String(username || '').toLowerCase().trim();
  if (!/^[a-z0-9_.-]{2,20}$/.test(uname)) return res.status(400).json({ error: 'Usernames are 2–20 characters: letters, numbers, dot, dash, underscore.' });
  if (db.players.some((p) => p.username === uname)) return res.status(409).json({ error: 'That username is taken.' });
  if (!password && !config.allowPasswordlessAccounts) {
    return res.status(400).json({ error: 'Give them a password. This install is on a public address.' });
  }
  if (password && String(password).length < 6) {
    return res.status(400).json({ error: 'If you set a password, make it at least 6 characters.' });
  }
  const p = A.newPlayer({ username: uname, displayName, password, role: role === 'site_admin' ? 'site_admin' : 'player' });
  db.players.push(p);
  db.save('players');
  logAudit(req.player.id, 'admin.player_created', { target: p.id, username: uname });
  res.json({ player: publicPlayer(p) });
});

router.patch('/players/:id', (req, res) => {
  const p = db.players.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'No such player.' });
  const { displayName, username, role, disabled, bio, accent } = req.body || {};
  const before = { role: p.role, disabled: p.disabled, username: p.username };

  if (username !== undefined) {
    const uname = String(username).toLowerCase().trim();
    if (!/^[a-z0-9_.-]{2,20}$/.test(uname)) return res.status(400).json({ error: 'That username will not work.' });
    if (db.players.some((x) => x.username === uname && x.id !== p.id)) return res.status(409).json({ error: 'That username is taken.' });
    p.username = uname;
  }
  if (displayName !== undefined) p.displayName = String(displayName).trim().slice(0, 32) || p.displayName;
  if (bio !== undefined) p.bio = String(bio).slice(0, 140);
  if (accent !== undefined && /^#[0-9a-f]{6}$/i.test(accent)) p.accent = accent;
  if (role !== undefined) {
    const admins = db.players.filter((x) => x.role === 'site_admin' && !x.disabled);
    if (p.role === 'site_admin' && role !== 'site_admin' && admins.length <= 1) {
      return res.status(400).json({ error: 'Promote someone else before stepping down. A site needs one poker admin.' });
    }
    p.role = role === 'site_admin' ? 'site_admin' : 'player';
  }
  if (disabled !== undefined) {
    p.disabled = !!disabled;
    if (p.disabled) A.revokeAllFor(p.id);
  }
  db.save('players');
  logAudit(req.player.id, 'admin.player_updated', { target: p.id, before, after: { role: p.role, disabled: p.disabled, username: p.username } });
  res.json({ player: publicPlayer(p) });
});

router.post('/players/:id/password', (req, res) => {
  const p = db.players.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'No such player.' });
  const next = String(req.body?.password || '');
  if (!next && !config.allowPasswordlessAccounts) {
    return res.status(400).json({ error: 'Accounts need a password on a public address.' });
  }
  // An empty value takes the password off, which is a normal thing to want here.
  if (next && next.length < 6) {
    return res.status(400).json({ error: 'If you set a password, make it at least 6 characters.' });
  }
  p.passwordHash = next ? A.hash(next) : null;
  if (req.body?.clearPin) p.pinHash = null;
  if (req.body?.signOutEverywhere !== false) A.revokeAllFor(p.id);
  db.save('players');
  logAudit(req.player.id, next ? 'admin.password_reset' : 'admin.password_removed', { target: p.id });
  res.json({ ok: true, hasPassword: !!p.passwordHash });
});

/**
 * Stat corrections are stored as deltas with a reason, never as overwrites, so
 * the original session history stays intact and every edit can be undone.
 */
router.post('/players/:id/stats', (req, res) => {
  const p = db.players.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'No such player.' });
  const { field, delta, target, reason } = req.body || {};
  if (!EDITABLE.includes(field)) return res.status(400).json({ error: 'That number cannot be corrected by hand.' });
  const current = stats.lifetime(p.id)[field] || 0;
  let d = Number(delta);
  if (target !== undefined && target !== null && target !== '') d = Number(target) - current;
  if (!Number.isFinite(d) || d === 0) return res.status(400).json({ error: 'Nothing to change.' });
  const adj = { id: id('adj'), field, delta: Math.round(d * 100) / 100, reason: String(reason || '').slice(0, 120), by: req.player.id, ts: Date.now() };
  p.statAdjustments = p.statAdjustments || [];
  p.statAdjustments.push(adj);
  db.save('players');
  logAudit(req.player.id, 'admin.stat_adjusted', { target: p.id, ...adj });
  res.json({ adjustment: adj, lifetime: stats.lifetime(p.id) });
});

router.get('/players/:id/stats', (req, res) => {
  const p = db.players.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'No such player.' });
  res.json({
    lifetime: stats.lifetime(p.id),
    adjustments: (p.statAdjustments || []).map((a) => ({
      ...a, byName: db.players.find((x) => x.id === a.by)?.displayName || 'Someone'
    }))
  });
});

router.delete('/players/:id/stats/:adjId', (req, res) => {
  const p = db.players.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'No such player.' });
  const i = (p.statAdjustments || []).findIndex((a) => a.id === req.params.adjId);
  if (i < 0) return res.status(404).json({ error: 'No such correction.' });
  const [removed] = p.statAdjustments.splice(i, 1);
  db.save('players');
  logAudit(req.player.id, 'admin.stat_adjustment_removed', { target: p.id, removed });
  res.json({ lifetime: stats.lifetime(p.id) });
});

/** Fold a duplicate or guest account into a real one. */
router.post('/players/:id/merge', (req, res) => {
  const from = db.players.find((x) => x.id === req.params.id);
  const into = db.players.find((x) => x.id === req.body?.into);
  if (!from || !into) return res.status(404).json({ error: 'Pick two accounts that exist.' });
  if (from.id === into.id) return res.status(400).json({ error: 'Pick two different accounts.' });

  for (const s of db.sessions) {
    for (const pos of s.positions || []) if (pos.playerId === from.id) pos.playerId = into.id;
    for (const e of s.ledger || []) {
      if (e.playerId === from.id) e.playerId = into.id;
      if (e.coveredBy === from.id) e.coveredBy = into.id;
    }
  }
  for (const r of db.rooms) {
    r.players = r.players.filter((rp) => rp.playerId !== from.id || !r.players.some((o) => o.playerId === into.id));
    for (const rp of r.players) if (rp.playerId === from.id) rp.playerId = into.id;
    for (const e of r.ledger) {
      if (e.playerId === from.id) e.playerId = into.id;
      if (e.coveredBy === from.id) e.coveredBy = into.id;
    }
    r.adminIds = [...new Set(r.adminIds.map((x) => (x === from.id ? into.id : x)))];
  }
  for (const b of db.balances) {
    if (b.from === from.id) b.from = into.id;
    if (b.to === from.id) b.to = into.id;
  }
  db.balances = db.balances.filter((b) => b.from !== b.to);
  into.statAdjustments = [...(into.statAdjustments || []), ...(from.statAdjustments || [])];
  from.disabled = true;
  from.mergedInto = into.id;
  A.revokeAllFor(from.id);

  db.save('players'); db.save('sessions'); db.save('rooms'); db.save('balances');
  logAudit(req.player.id, 'admin.players_merged', { from: from.id, into: into.id });
  res.json({ ok: true, lifetime: stats.lifetime(into.id) });
});

router.delete('/players/:id', (req, res) => {
  const i = db.players.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'No such player.' });
  const p = db.players[i];
  if (p.id === req.player.id) return res.status(400).json({ error: 'You cannot delete your own account here.' });
  if (db.sessions.some((s) => s.positions?.some((pos) => pos.playerId === p.id))) {
    return res.status(400).json({ error: 'This account has game history. Switch it off or merge it instead of deleting.' });
  }
  if (p.avatar) media.remove(p.avatar);
  db.players.splice(i, 1);
  A.revokeAllFor(p.id);
  db.save('players');
  logAudit(req.player.id, 'admin.player_deleted', { target: p.id, username: p.username });
  res.json({ ok: true });
});

router.patch('/settings', (req, res) => {
  const s = db.settings;
  const b = req.body || {};
  if (b.siteName !== undefined) s.siteName = String(b.siteName).slice(0, 40) || s.siteName;
  if (b.currency !== undefined) s.currency = String(b.currency).slice(0, 3) || s.currency;
  if (b.allowSelfSignup !== undefined) s.allowSelfSignup = !!b.allowSelfSignup;
  if (b.carryDebtBetweenSessions !== undefined) s.carryDebtBetweenSessions = !!b.carryDebtBetweenSessions;
  for (const k of ['defaultBuyIn', 'minBuyIn', 'buyInIncrement']) {
    if (b[k] !== undefined && Number.isFinite(Number(b[k]))) s[k] = Number(b[k]);
  }
  db.save('settings');
  logAudit(req.player.id, 'admin.settings_updated', b);
  res.json({ settings: s });
});

/**
 * The name and mark the whole install wears. Both belong to whoever owns the
 * install, not to the person who happened to write it.
 */
router.post('/brand', (req, res) => {
  try {
    const saved = media.saveDataUrl('brand', req.body?.dataUrl);
    if (db.settings.logo) media.remove(db.settings.logo);
    db.settings.logo = saved.url;
    db.settings.logoMime = saved.mime;
    db.save('settings');
    logAudit(req.player.id, 'admin.logo_changed', { bytes: saved.bytes });
    res.json({ logo: db.settings.logo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/brand', (req, res) => {
  if (db.settings.logo) media.remove(db.settings.logo);
  db.settings.logo = null;
  db.settings.logoMime = null;
  db.save('settings');
  logAudit(req.player.id, 'admin.logo_cleared', {});
  res.json({ logo: null });
});

router.get('/balances', (_req, res) => {
  res.json({
    balances: db.balances.map((b) => ({
      ...b,
      fromName: db.players.find((p) => p.id === b.from)?.displayName || 'Unknown',
      toName: db.players.find((p) => p.id === b.to)?.displayName || 'Unknown'
    })).sort((a, b) => b.amount - a.amount)
  });
});

router.post('/balances/clear', (req, res) => {
  const { from, to } = req.body || {};
  const before = db.balances.length;
  db.balances = db.balances.filter((b) => !(b.from === from && b.to === to));
  db.save('balances');
  logAudit(req.player.id, 'admin.balance_cleared', { from, to, removed: before - db.balances.length });
  res.json({ ok: true });
});

router.get('/audit', (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 1000);
  res.json({
    audit: db.audit.slice(0, limit).map((a) => ({
      ...a, actorName: db.players.find((p) => p.id === a.actorId)?.displayName || 'System'
    }))
  });
});

router.get('/sessions', (_req, res) => {
  res.json({
    sessions: db.sessions.slice().reverse().slice(0, 100).map((s) => ({
      id: s.id, name: s.name, code: s.code, endedAt: s.endedAt, durationMs: s.durationMs,
      games: s.games, players: s.positions?.length || 0,
      volume: (s.positions || []).reduce((n, p) => n + p.buyIn, 0)
    }))
  });
});

/**
 * Everything, in one file: the data folder and every upload. Restoring is a
 * matter of dropping the two folders back in place, which is documented in the
 * README that ships inside the archive.
 */
router.get('/backup.zip', (req, res) => {
  const root = path.join(__dirname, '..', '..');
  const files = [];

  const add = (absDir, prefix) => {
    if (!fs.existsSync(absDir)) return;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      // The TLS private key is machine-specific and regenerates itself. It has
      // no business sitting in a file people pass around.
      if (entry.name === 'cert') continue;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) { add(abs, `${prefix}${entry.name}/`); continue; }
      const stat = fs.statSync(abs);
      files.push({ name: `${prefix}${entry.name}`, data: fs.readFileSync(abs), date: stat.mtime });
    }
  };

  db.flushNow();
  add(path.join(root, 'data'), 'data/');
  add(path.join(root, 'uploads'), 'uploads/');

  const stamp = new Date().toISOString().slice(0, 10);
  files.push({
    name: 'HOW-TO-RESTORE.txt',
    data: Buffer.from(
      `${db.settings.siteName} backup — ${new Date().toString()}\n\n`
      + `Accounts: ${db.players.length}\n`
      + `Nights played: ${db.sessions.length}\n`
      + `Open tables: ${db.rooms.filter((r) => r.status !== 'ended').length}\n\n`
      + 'To restore:\n'
      + '  1. Stop the app.\n'
      + '  2. Copy the "data" and "uploads" folders from this archive into the\n'
      + `     ${db.settings.siteName} folder, replacing what is there.\n`
      + '  3. Start the app again.\n\n'
      + 'That is the whole database. Passwords are hashed and stay hashed.\n', 'utf8')
  });

  try {
    const archive = zip.build(files);
    logAudit(req.player.id, 'admin.backup_downloaded', { files: files.length, bytes: archive.length });
    res.set('Content-Type', 'application/zip');
    const slug = db.settings.siteName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'poker-hub';
    res.set('Content-Disposition', `attachment; filename="${slug}-backup-${stamp}.zip"`);
    res.send(archive);
  } catch (err) {
    res.status(500).json({ error: 'Could not build the backup.' });
  }
});

router.delete('/rooms/:id', (req, res) => {
  const i = db.rooms.findIndex((r) => r.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'No such room.' });
  const [room] = db.rooms.splice(i, 1);
  room.photos?.forEach((p) => media.remove(p.url));
  db.save('rooms');
  logAudit(req.player.id, 'admin.room_deleted', { roomId: room.id, code: room.code });
  res.json({ ok: true });
});

module.exports = router;
