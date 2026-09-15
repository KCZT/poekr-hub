'use strict';
const crypto = require('crypto');
const { db, id } = require('./store');
const config = require('./config');

/**
 * Sign-ins live on disk, not just in memory. Restarting the app used to sign
 * the whole table out mid-game, which on a laptop that sleeps is not rare.
 *
 * Only a hash of each token is stored: the file is as good as a stack of
 * session cookies otherwise, and it ends up inside backups.
 */
const sessions = new Map(); // tokenHash -> { playerId, created, lastSeen }
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days

const digest = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

let saveQueued = false;
function persist() {
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(() => {
    saveQueued = false;
    db.tokens.length = 0;
    for (const [hash, s] of sessions) {
      db.tokens.push({ hash, playerId: s.playerId, created: s.created, lastSeen: s.lastSeen });
    }
    db.save('tokens');
  }, 200);
}

(function hydrate() {
  const now = Date.now();
  let dropped = 0;
  for (const rec of db.tokens) {
    if (!rec?.hash || now - (rec.created || 0) > SESSION_TTL) { dropped += 1; continue; }
    sessions.set(rec.hash, { playerId: rec.playerId, created: rec.created, lastSeen: rec.lastSeen || rec.created });
  }
  if (dropped) persist();
}());

function hash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verify(password, stored) {
  if (!stored) return false;
  const [salt, derived] = String(stored).split(':');
  if (!salt || !derived) return false;
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function issueToken(playerId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(digest(token), { playerId, created: Date.now(), lastSeen: Date.now() });
  persist();
  return token;
}

function revoke(token) {
  if (sessions.delete(digest(token))) persist();
}

function revokeAllFor(playerId) {
  let hit = false;
  for (const [t, s] of sessions) if (s.playerId === playerId) { sessions.delete(t); hit = true; }
  if (hit) persist();
}

function playerFromToken(token) {
  const hash = digest(token);
  const s = sessions.get(hash);
  if (!s) return null;
  if (Date.now() - s.created > SESSION_TTL) { sessions.delete(hash); persist(); return null; }
  s.lastSeen = Date.now();
  const p = db.players.find((x) => x.id === s.playerId);
  if (!p || p.disabled) return null;
  return p;
}

function tokenFrom(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return req.query.token || null;
}

/** Populates req.player when a valid token is present. Never rejects. */
function attach(req, _res, next) {
  req.token = tokenFrom(req);
  req.player = req.token ? playerFromToken(req.token) : null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.player) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
}

/**
 * On a local network, reading a table is open — the people who can reach it are
 * the people in the room. On a public address that reasoning evaporates, so the
 * same routes close up. One switch, applied everywhere it matters.
 */
function requireAuthToRead(req, res, next) {
  if (!config.requireAuthToRead) return next();
  return requireAuth(req, res, next);
}

function requireSiteAdmin(req, res, next) {
  if (!req.player) return res.status(401).json({ error: 'Sign in to continue.' });
  if (req.player.role !== 'site_admin') {
    return res.status(403).json({ error: 'Only a poker admin can do that.' });
  }
  next();
}

/** Room admin = listed in room.adminIds, or any site admin. */
function isRoomAdmin(room, player) {
  if (!player || !room) return false;
  if (player.role === 'site_admin') return true;
  return (room.adminIds || []).includes(player.id);
}

/**
 * A password is optional. Plenty of these accounts belong to people sitting at
 * the same table as the computer, where "prove it's you" is answered by being
 * in the room. An account with no password signs in by being picked.
 */
function newPlayer({ username, displayName, password, role = 'player' }) {
  return {
    id: id('p'),
    username: String(username).toLowerCase().trim(),
    displayName: displayName || username,
    passwordHash: password ? hash(password) : null,
    pinHash: null,
    role, // 'player' | 'site_admin'
    avatar: null,
    accent: pickAccent(username),
    suit: pickSuit(username),
    bio: '',
    payHandles: { venmo: '', cashapp: '', paypal: '' },
    walkupSoundId: null,
    createdAt: Date.now(),
    disabled: false,
    statAdjustments: [], // manual corrections by a poker admin, always audited
    shareToken: null,
    settings: { soundVolume: 0.7 }
  };
}

const ACCENTS = ['#D6A93B', '#C33A3A', '#4A7FA5', '#7A9E5B', '#9B6BB0', '#D07C3F', '#3FAF9E', '#C25A8A'];
const SUITS = ['spade', 'heart', 'club', 'diamond'];

function sum(str) {
  let n = 0;
  for (const ch of String(str)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return n;
}
function pickAccent(seed) { return ACCENTS[sum(seed) % ACCENTS.length]; }
function pickSuit(seed) { return SUITS[sum(seed + '!') % SUITS.length]; }

module.exports = {
  hash, verify, issueToken, revoke, revokeAllFor, attach,
  requireAuth, requireAuthToRead, requireSiteAdmin, isRoomAdmin, newPlayer, sessions
};
