'use strict';
const express = require('express');
const { db, logAudit } = require('../store');
const A = require('../auth');
const limiter = require('../limiter');
const config = require('../config');

const router = express.Router();

const USERNAME = /^[a-z0-9_.-]{2,20}$/;

function publicPlayer(p, self = false) {
  if (!p) return null;
  const out = {
    id: p.id, username: p.username, displayName: p.displayName, avatar: p.avatar,
    accent: p.accent, suit: p.suit, role: p.role, bio: p.bio,
    payHandles: p.payHandles, disabled: !!p.disabled, createdAt: p.createdAt,
    walkupSoundId: p.walkupSoundId, hasShare: !!p.shareToken
  };
  if (self) {
    out.settings = p.settings;
    out.hasPin = !!p.pinHash;
    out.hasPassword = !!p.passwordHash;
    out.shareToken = p.shareToken;
  }
  return out;
}

router.post('/signup', (req, res) => {
  const { username, displayName, password } = req.body || {};
  const first = db.players.length === 0;
  if (!first && !db.settings.allowSelfSignup) {
    return res.status(403).json({ error: 'Sign-ups are closed. Ask the poker admin for an account.' });
  }
  const uname = String(username || '').toLowerCase().trim();
  if (!USERNAME.test(uname)) {
    return res.status(400).json({ error: 'Usernames are 2–20 characters: letters, numbers, dot, dash, underscore.' });
  }
  if (db.players.some((p) => p.username === uname)) {
    return res.status(409).json({ error: 'That username is taken.' });
  }
  if (!password && !config.allowPasswordlessAccounts) {
    return res.status(400).json({ error: 'Pick a password. This install is on a public address, so accounts need one.' });
  }
  if (password && String(password).length < 6) {
    return res.status(400).json({ error: 'If you set a password, make it at least 6 characters.' });
  }
  const player = A.newPlayer({
    username: uname,
    displayName: String(displayName || uname).slice(0, 32),
    password,
    role: first ? 'site_admin' : 'player'
  });
  db.players.push(player);
  db.save('players');
  logAudit(player.id, first ? 'account.created.first' : 'account.created', { username: uname });
  res.json({ token: A.issueToken(player.id), player: publicPlayer(player, true), firstAccount: first });
});

router.post('/login',
  limiter.guard((req) => `login:${String(req.body?.username || '').toLowerCase().trim()}`),
  (req, res) => {
    const { username, password } = req.body || {};
    const p = db.players.find((x) => x.username === String(username || '').toLowerCase().trim());
    if (!p) {
      req.limiter?.fail();
      return res.status(401).json({ error: 'No account by that name.' });
    }
    if (!p.passwordHash && !config.allowPasswordlessAccounts) {
      return res.status(403).json({
        error: 'This account has no password, and one is needed here. Ask whoever runs this to set you one.'
      });
    }
    // Nothing to guess at on an account with no password, so nothing to
    // rate limit either — picking the name is the whole sign-in.
    if (p.passwordHash && !A.verify(password, p.passwordHash)) {
      req.limiter?.fail();
      return res.status(401).json({ error: 'That password does not match.' });
    }
    if (p.disabled) return res.status(403).json({ error: 'This account is switched off. Ask the poker admin.' });
    req.limiter?.succeed();
    res.json({ token: A.issueToken(p.id), player: publicPlayer(p, true) });
  });

/** Quick re-auth on a shared table device. */
router.post('/pin',
  limiter.guard((req) => `pin:${req.body?.playerId || 'unknown'}`),
  (req, res) => {
    const { playerId, pin } = req.body || {};
    const p = db.players.find((x) => x.id === playerId);
    if (!p || !p.pinHash || !A.verify(pin, p.pinHash)) {
      req.limiter?.fail();
      return res.status(401).json({ error: 'Wrong PIN.' });
    }
    if (p.disabled) return res.status(403).json({ error: 'This account is switched off.' });
    req.limiter?.succeed();
    res.json({ token: A.issueToken(p.id), player: publicPlayer(p, true) });
  });

router.post('/logout', A.attach, (req, res) => {
  if (req.token) A.revoke(req.token);
  res.json({ ok: true });
});

router.get('/me', A.attach, (req, res) => {
  if (!req.player) return res.status(401).json({ error: 'Not signed in.' });
  res.json({ player: publicPlayer(req.player, true), settings: db.settings });
});

router.post('/password', A.attach, A.requireAuth,
  limiter.guard((req) => `pwchange:${req.player?.id}`),
  (req, res) => {
  const { current, next } = req.body || {};
  // Only an account that already has one has to prove it knows it.
  if (req.player.passwordHash && !A.verify(current, req.player.passwordHash)) {
    req.limiter?.fail();
    return res.status(401).json({ error: 'Your current password is wrong.' });
  }
  req.limiter?.succeed();
  if ((next === '' || next === null) && !config.allowPasswordlessAccounts) {
    return res.status(400).json({ error: 'This install is on a public address, so your account needs a password.' });
  }
  if (next === '' || next === null) {
    req.player.passwordHash = null;
    db.save('players');
    logAudit(req.player.id, 'account.password_removed', {});
    return res.json({ ok: true, hasPassword: false });
  }
  if (String(next || '').length < 6) {
    return res.status(400).json({ error: 'Passwords need at least 6 characters.' });
  }
  req.player.passwordHash = A.hash(next);
  db.save('players');
  logAudit(req.player.id, 'account.password_changed', {});
  res.json({ ok: true, hasPassword: true });
});

router.post('/set-pin', A.attach, A.requireAuth, (req, res) => {
  const { pin, password } = req.body || {};
  if (req.player.passwordHash && !A.verify(password, req.player.passwordHash)) {
    return res.status(401).json({ error: 'Confirm with your password first.' });
  }
  if (pin === null || pin === '') {
    req.player.pinHash = null;
  } else if (!/^\d{4,8}$/.test(String(pin))) {
    return res.status(400).json({ error: 'A PIN is 4 to 8 digits.' });
  } else {
    req.player.pinHash = A.hash(String(pin));
  }
  db.save('players');
  res.json({ ok: true, hasPin: !!req.player.pinHash });
});

/**
 * Names and avatars only, for the pick-your-face screen. Anyone who can get in
 * without typing a password belongs here: those with a PIN, and those with no
 * password at all. `needsPin` tells the screen which one it is dealing with.
 */
router.get('/faces', (_req, res) => {
  if (!config.allowPasswordlessAccounts) return res.json({ players: [] });
  res.json({
    players: db.players
      .filter((p) => !p.disabled && !p.isGuest && (p.pinHash || !p.passwordHash))
      .map((p) => ({
        id: p.id, displayName: p.displayName, avatar: p.avatar,
        accent: p.accent, suit: p.suit, needsPin: !!p.pinHash
      }))
  });
});

/** Tap your face on an account with no password and no PIN. */
router.post('/pick', limiter.guard((req) => `pick:${req.body?.playerId || 'unknown'}`), (req, res) => {
  if (!config.allowPasswordlessAccounts) {
    return res.status(403).json({ error: 'Not here. Sign in with a username and password.' });
  }
  const p = db.players.find((x) => x.id === req.body?.playerId);
  if (!p || p.disabled || p.isGuest) return res.status(404).json({ error: 'No such account.' });
  if (p.passwordHash) {
    return res.status(401).json({ error: 'That account has a password. Sign in with it.' });
  }
  if (p.pinHash) return res.status(401).json({ error: 'That account has a PIN. Enter it.' });
  res.json({ token: A.issueToken(p.id), player: publicPlayer(p, true) });
});

module.exports = { router, publicPlayer };
