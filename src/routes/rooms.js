'use strict';
const express = require('express');
const crypto = require('crypto');
const QR = require('qrcode');
const { db, logAudit, id } = require('../store');
const A = require('../auth');
const L = require('../ledger');
const G = require('../games');
const stats = require('../stats');
const media = require('../media');
const events = require('../events');
const limiter = require('../limiter');
const { publicPlayer } = require('./auth');
const config = require('../config');

const router = express.Router();
router.use(A.attach);

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes
function newCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (db.rooms.some((r) => r.code === code));
  return code;
}

function findRoom(req, res, next) {
  const key = String(req.params.id || '').toUpperCase();
  const room = db.rooms.find((r) => r.id === req.params.id || r.code === key);
  if (!room) return res.status(404).json({ error: 'That room is not here any more.' });
  req.room = ensureShape(room);
  next();
}

/**
 * Hosted, a table is only readable by the people at it. A locked table on a
 * public address that anyone could read would make the password decorative.
 */
function needRoomAccess(req, res, next) {
  if (!config.requireAuthToRead) return next();
  const room = req.room;
  if (A.isRoomAdmin(room, req.player) || (req.player && isMember(room, req.player.id))) return next();
  return res.status(403).json({ error: 'You are not at this table.' });
}

function needRoomAdmin(req, res, next) {
  if (!A.isRoomAdmin(req.room, req.player)) {
    return res.status(403).json({ error: 'Only the room admin can do that.' });
  }
  next();
}

function isMember(room, playerId) {
  return (room.players || []).some((p) => p.playerId === playerId && p.status !== 'removed');
}

function feed(room, kind, text, playerId, extra) {
  const item = { id: id('f'), ts: Date.now(), kind, text, playerId: playerId || null, ...extra };
  room.feed.unshift(item);
  if (room.feed.length > 300) room.feed.length = 300;
  events.publish(room.id, 'feed', item);
  return item;
}

function push(room) {
  db.save('rooms');
  events.publish(room.id, 'state', { at: Date.now() });
}

/** Rooms saved before a feature existed still have to open. */
function ensureShape(room) {
  room.penalties = room.penalties || [];
  for (const rp of room.players) {
    if (rp.seatedMs === undefined) rp.seatedMs = 0;
    if (rp.seatedSince === undefined) rp.seatedSince = null;
  }
  room.config.shotName = room.config.shotName || 'Dick shot';
  if (room.config.shotsEnabled === undefined) room.config.shotsEnabled = true;
  if (!room.dealerId) {
    room.dealerId = room.players.find((p) => p.status === 'seated')?.playerId || null;
  }
  return room;
}

/**
 * Time at the table, counted per person.
 *
 * Crediting everyone with the whole night's length made a player who turned up
 * for the last hour look like they sat through all six, which put every $/hour
 * figure out. The clock only runs while the game is actually going and while
 * that person is actually seated.
 */
function openSeat(room, rp) {
  if (!rp) return;
  if (room.status === 'active' && rp.status === 'seated' && !rp.seatedSince) {
    rp.seatedSince = Date.now();
  }
}

function closeSeat(rp) {
  if (!rp || !rp.seatedSince) return;
  rp.seatedMs = (rp.seatedMs || 0) + (Date.now() - rp.seatedSince);
  rp.seatedSince = null;
}

function seatedMs(rp) {
  return (rp?.seatedMs || 0) + (rp?.seatedSince ? Date.now() - rp.seatedSince : 0);
}

function currentSegment(room) {
  return room.segments.find((s) => !s.endedAt) || room.segments[room.segments.length - 1] || null;
}

function countShots(room, playerId) {
  const mine = room.penalties.filter((p) => p.playerId === playerId);
  return {
    taken: mine.filter((p) => p.status === 'taken').length,
    refused: mine.filter((p) => p.status === 'refused').length,
    pending: mine.filter((p) => p.status === 'pending').length
  };
}

/** Everything the client renders, shaped for one screen. */
function view(room, viewer) {
  const pos = L.positions(room);
  const admin = A.isRoomAdmin(room, viewer);
  return {
    id: room.id,
    code: room.code,
    name: room.name,
    status: room.status,
    locked: !!room.passwordHash,
    createdAt: room.createdAt,
    startedAt: room.startedAt,
    endedAt: room.endedAt,
    config: room.config,
    adminIds: room.adminIds,
    isAdmin: admin,
    isMember: viewer ? isMember(room, viewer.id) : false,
    segment: currentSegment(room),
    segments: room.segments,
    watching: events.listenerCount(room.id),
    shareToken: room.shareToken,
    sounds: room.sounds,
    photos: room.photos,
    dealerId: room.dealerId,
    penalties: room.penalties.slice(-40).reverse(),
    openPenalties: room.penalties.filter((p) => p.status === 'pending'),
    feed: room.feed.slice(0, 60),
    requests: room.requests.filter((r) => r.status === 'pending'),
    pot: L.potState(room),
    players: room.players.map((rp) => {
      const p = db.players.find((x) => x.id === rp.playerId);
      const m = pos.get(rp.playerId) || {};
      return {
        ...rp,
        displayName: p?.displayName || rp.guestName || 'Guest',
        avatar: p?.avatar || null,
        accent: p?.accent || '#8a8f8a',
        suit: p?.suit || 'spade',
        isGuest: !!p?.isGuest,
        isRoomAdmin: (room.adminIds || []).includes(rp.playerId),
        isDealer: room.dealerId === rp.playerId,
        seatedMs: seatedMs(rp),
        shots: countShots(room, rp.playerId),
        money: {
          buyIn: m.buyIn || 0, cashOut: m.cashOut || 0, result: m.result || 0,
          onCredit: m.onCredit || 0, remaining: m.remaining || 0, expenses: m.expenses || 0,
          shortBuys: m.shortBuys || 0, rebuys: m.rebuys || 0
        }
      };
    }),
    ledger: room.ledger.slice(-120).reverse()
  };
}

// ── Rooms ────────────────────────────────────────────────────────────────────

router.get('/', A.requireAuthToRead, (req, res) => {
  const rooms = db.rooms
    .filter((r) => r.status !== 'ended')
    .map((r) => ({
      id: r.id, code: r.code, name: r.name, status: r.status, locked: !!r.passwordHash,
      players: r.players.filter((p) => p.status !== 'removed').length,
      game: currentSegment(r)?.game || null,
      pot: L.potState(r).chipsInPlay,
      createdAt: r.createdAt,
      mine: req.player ? isMember(r, req.player.id) : false
    }))
    .sort((a, b) => Number(b.mine) - Number(a.mine) || b.createdAt - a.createdAt);
  res.json({ rooms });
});

router.post('/', A.requireAuth, (req, res) => {
  const { name, password, game = 'texas_holdem', config = {} } = req.body || {};
  if (!G.isGame(game)) return res.status(400).json({ error: 'Pick a game to start with.' });
  const s = db.settings;
  const room = {
    id: id('r'),
    code: newCode(),
    name: String(name || '').trim().slice(0, 40) || `${req.player.displayName}’s table`,
    createdBy: req.player.id,
    adminIds: [req.player.id],
    passwordHash: password ? A.hash(password) : null,
    status: 'lobby',
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    config: {
      currency: config.currency || s.currency,
      defaultBuyIn: num(config.defaultBuyIn, s.defaultBuyIn),
      minBuyIn: num(config.minBuyIn, s.minBuyIn),
      maxBuyIn: num(config.maxBuyIn, 500),
      buyInIncrement: num(config.buyInIncrement, s.buyInIncrement),
      allowShortBuy: config.allowShortBuy !== false,
      allowCredit: config.allowCredit !== false,
      creditNeedsApproval: config.creditNeedsApproval !== false,
      selfServeBuyIn: config.selfServeBuyIn !== false,
      carryDebt: config.carryDebt !== false,
      bankerId: config.bankerId || req.player.id,
      shotName: String(config.shotName || 'Dick shot').slice(0, 24),
      shotsEnabled: config.shotsEnabled !== false
    },
    segments: [{
      id: id('s'), game, config: { ...G.defaults(game), ...(config.gameConfig || {}) },
      startedAt: Date.now(), endedAt: null
    }],
    players: [{ playerId: req.player.id, seat: 1, joinedAt: Date.now(), leftAt: null, status: 'seated' }],
    ledger: [],
    requests: [],
    photos: [],
    sounds: {},
    feed: [],
    penalties: [],
    dealerId: req.player.id,
    shareToken: null
  };
  db.rooms.push(room);
  feed(room, 'room', `${req.player.displayName} opened the table.`, req.player.id);
  db.save('rooms');
  logAudit(req.player.id, 'room.created', { roomId: room.id, code: room.code });
  res.json({ room: view(room, req.player) });
});

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

router.get('/:id', findRoom, A.requireAuthToRead, needRoomAccess, (req, res) => {
  res.json({ room: view(req.room, req.player) });
});

router.post('/:id/join', findRoom, A.requireAuth,
  limiter.guard((req) => `room:${req.params.id}`),
  (req, res) => {
  const room = req.room;
  if (room.status === 'ended') return res.status(400).json({ error: 'This game is over.' });
  const existing = room.players.find((p) => p.playerId === req.player.id);
  if (!existing || existing.status === 'removed') {
    if (room.passwordHash && !A.verify(req.body?.password, room.passwordHash)) {
      req.limiter?.fail();
      return res.status(401).json({ error: 'Wrong table password.' });
    }
    req.limiter?.succeed();
  }
  if (existing) {
    existing.status = 'seated';
    existing.leftAt = null;
    openSeat(room, existing);
  } else {
    const seat = (room.players.reduce((m, p) => Math.max(m, p.seat || 0), 0) || 0) + 1;
    room.players.push({ playerId: req.player.id, seat, joinedAt: Date.now(), leftAt: null, status: 'seated', seatedMs: 0, seatedSince: null });
    openSeat(room, room.players[room.players.length - 1]);
    feed(room, 'join', `${req.player.displayName} sat down.`, req.player.id);
    events.publish(room.id, 'walkup', { playerId: req.player.id });
  }
  push(room);
  res.json({ room: view(room, req.player) });
});

/** A room admin can seat someone who does not have an account yet. */
router.post('/:id/guests', findRoom, A.requireAuth, needRoomAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 32);
  if (!name) return res.status(400).json({ error: 'Give the guest a name.' });
  const guest = A.newPlayer({ username: `guest_${crypto.randomBytes(3).toString('hex')}`, displayName: name, password: crypto.randomBytes(16).toString('hex') });
  guest.isGuest = true;
  db.players.push(guest);
  db.save('players');
  const seat = (req.room.players.reduce((m, p) => Math.max(m, p.seat || 0), 0) || 0) + 1;
  req.room.players.push({ playerId: guest.id, seat, joinedAt: Date.now(), leftAt: null, status: 'seated', isGuest: true, seatedMs: 0, seatedSince: null });
  openSeat(req.room, req.room.players[req.room.players.length - 1]);
  feed(req.room, 'join', `${name} sat down as a guest.`, guest.id);
  push(req.room);
  res.json({ room: view(req.room, req.player), guest: publicPlayer(guest) });
});

router.post('/:id/leave', findRoom, A.requireAuth, (req, res) => {
  const rp = req.room.players.find((p) => p.playerId === req.player.id);
  if (rp) {
    closeSeat(rp);
    rp.status = 'away';
    rp.leftAt = Date.now();
    feed(req.room, 'leave', `${req.player.displayName} stepped away.`, req.player.id);
    push(req.room);
  }
  res.json({ ok: true });
});

router.post('/:id/kick', findRoom, A.requireAuth, needRoomAdmin, (req, res) => {
  const { playerId } = req.body || {};
  const rp = req.room.players.find((p) => p.playerId === playerId);
  if (!rp) return res.status(404).json({ error: 'They are not at this table.' });
  const money = L.positions(req.room).get(playerId);
  if (money && Math.abs(money.remaining) > 0.009) {
    return res.status(400).json({ error: 'Settle their money before removing them.' });
  }
  closeSeat(rp);
  rp.status = 'removed';
  const name = db.players.find((p) => p.id === playerId)?.displayName || 'A player';
  feed(req.room, 'leave', `${name} was removed from the table.`, playerId);
  push(req.room);
  res.json({ room: view(req.room, req.player) });
});

router.patch('/:id', findRoom, A.requireAuth, needRoomAdmin, (req, res) => {
  const { name, config, password } = req.body || {};
  const room = req.room;
  if (name !== undefined) room.name = String(name).trim().slice(0, 40) || room.name;
  if (password !== undefined) room.passwordHash = password ? A.hash(password) : null;
  if (config && typeof config === 'object') {
    room.config = {
      ...room.config,
      ...['defaultBuyIn', 'minBuyIn', 'maxBuyIn', 'buyInIncrement'].reduce((o, k) => {
        if (config[k] !== undefined) o[k] = num(config[k], room.config[k]);
        return o;
      }, {}),
      ...['allowShortBuy', 'allowCredit', 'creditNeedsApproval', 'selfServeBuyIn', 'carryDebt', 'shotsEnabled'].reduce((o, k) => {
        if (config[k] !== undefined) o[k] = !!config[k];
        return o;
      }, {}),
      shotName: config.shotName !== undefined
        ? (String(config.shotName).trim().slice(0, 24) || room.config.shotName)
        : room.config.shotName,
      currency: config.currency || room.config.currency,
      bankerId: config.bankerId && isMember(room, config.bankerId) ? config.bankerId : room.config.bankerId
    };
  }
  push(room);
  res.json({ room: view(room, req.player) });
});

router.post('/:id/admins', findRoom, A.requireAuth, needRoomAdmin, (req, res) => {
  const { playerId, grant } = req.body || {};
  const room = req.room;
  if (!db.players.some((p) => p.id === playerId)) return res.status(404).json({ error: 'No such player.' });
  if (grant === false) {
    if (playerId === room.createdBy) return res.status(400).json({ error: 'The person who opened the table keeps their admin role.' });
    room.adminIds = room.adminIds.filter((x) => x !== playerId);
  } else if (!room.adminIds.includes(playerId)) {
    room.adminIds.push(playerId);
    const name = db.players.find((p) => p.id === playerId)?.displayName;
    feed(room, 'room', `${name} can now run the room.`, playerId);
  }
  push(room);
  res.json({ room: view(room, req.player) });
});

router.post('/:id/start', findRoom, A.requireAuth, needRoomAdmin, (req, res) => {
  const room = req.room;
  if (room.status === 'active') return res.json({ room: view(room, req.player) });
  room.status = 'active';
  room.startedAt = Date.now();
  for (const rp of room.players) openSeat(room, rp);
  const seg = currentSegment(room);
  feed(room, 'room', `Cards in the air: ${G.label(seg?.game)}.`);
  events.publish(room.id, 'sound', { event: 'game_start' });
  push(room);
  res.json({ room: view(room, req.player) });
});

// ── Game switching ───────────────────────────────────────────────────────────

/**
 * Close the current stretch of play and open a new one with a different game.
 * The money never moves — chips stay on the table across the switch — so a
 * blackjack intermission in the middle of a hold'em night is just a new segment.
 */
router.post('/:id/segments', findRoom, A.requireAuth, needRoomAdmin, (req, res) => {
  const { game, config = {}, note } = req.body || {};
  if (!G.isGame(game)) return res.status(400).json({ error: 'Pick a game from the list.' });
  const room = req.room;
  const prev = currentSegment(room);
  if (prev && !prev.endedAt) prev.endedAt = Date.now();
  const seg = {
    id: id('s'),
    game,
    config: { ...G.defaults(game), ...config },
    startedAt: Date.now(),
    endedAt: null,
    note: String(note || '').slice(0, 80)
  };
  room.segments.push(seg);
  feed(room, 'game', `Switching to ${G.label(game)}${note ? ` — ${note}` : ''}.`);
  events.publish(room.id, 'sound', { event: 'game_change' });
  events.publish(room.id, 'game_change', { game, name: G.label(game) });
  push(room);
  res.json({ room: view(room, req.player) });
});

// ── Money ────────────────────────────────────────────────────────────────────

router.post('/:id/buyin', findRoom, A.requireAuth, (req, res) => {
  const room = req.room;
  const admin = A.isRoomAdmin(room, req.player);
  const targetId = req.body?.playerId || req.player.id;
  if (targetId !== req.player.id && !admin) {
    return res.status(403).json({ error: 'Only the room admin can buy in for someone else.' });
  }
  if (!isMember(room, targetId)) return res.status(400).json({ error: 'They need to sit down first.' });
  if (room.status === 'ended') return res.status(400).json({ error: 'This game is over.' });

  const amount = L.round(Number(req.body?.amount));
  const funding = ['cash', 'credit', 'covered'].includes(req.body?.funding) ? req.body.funding : 'cash';
  const coveredBy = funding === 'covered' ? req.body?.coveredBy : null;

  const check = L.checkBuyIn(room, amount, admin);
  if (!check.ok && !check.needsApproval) return res.status(400).json({ error: check.reason });
  if (funding === 'covered') {
    if (!coveredBy || !isMember(room, coveredBy)) {
      return res.status(400).json({ error: 'Pick who is fronting the money.' });
    }
    if (coveredBy === targetId) return res.status(400).json({ error: 'Pick someone else to front it.' });
  }
  if (funding === 'credit' && !room.config.allowCredit) {
    return res.status(400).json({ error: 'This table is cash only.' });
  }

  const needsApproval = !admin && (
    check.needsApproval ||
    !room.config.selfServeBuyIn ||
    (funding === 'credit' && room.config.creditNeedsApproval) ||
    funding === 'covered'
  );

  if (needsApproval) {
    const request = {
      id: id('q'), type: 'buyin', playerId: targetId, amount, funding, coveredBy,
      short: !!check.short, note: String(req.body?.note || '').slice(0, 80),
      ts: Date.now(), status: 'pending', requestedBy: req.player.id
    };
    room.requests.push(request);
    const name = db.players.find((p) => p.id === targetId)?.displayName;
    feed(room, 'request', `${name} asked for ${room.config.currency}${amount}${check.short ? ' (short buy)' : ''}.`, targetId);
    events.publish(room.id, 'sound', { event: 'request' });
    push(room);
    return res.json({ pending: true, request, room: view(room, req.player) });
  }

  addBuyIn(room, { targetId, amount, funding, coveredBy, short: !!check.short, by: req.player.id, note: req.body?.note });
  push(room);
  res.json({ room: view(room, req.player) });
});

function addBuyIn(room, { targetId, amount, funding, coveredBy, short, by, note, approvedBy }) {
  const seg = currentSegment(room);
  const entry = {
    id: id('e'), ts: Date.now(), type: 'buyin', playerId: targetId, amount,
    funding, coveredBy: coveredBy || null, short: !!short,
    segmentId: seg?.id || null, createdBy: by, approvedBy: approvedBy || null,
    note: String(note || '').slice(0, 80), voided: false
  };
  room.ledger.push(entry);
  const p = db.players.find((x) => x.id === targetId);
  const cur = room.config.currency;
  const how = funding === 'cash' ? '' :
    funding === 'credit' ? ' on credit' :
      ` — ${db.players.find((x) => x.id === coveredBy)?.displayName} fronted it`;
  feed(room, 'buyin', `${p?.displayName} bought in for ${cur}${amount}${short ? ' (short)' : ''}${how}.`, targetId, { amount });
  events.publish(room.id, 'sound', { event: 'buyin' });
  return entry;
}

router.post('/:id/requests/:rid', findRoom, A.requireAuth, needRoomAdmin, (req, res) => {
  const room = req.room;
  const request = room.requests.find((r) => r.id === req.params.rid);
  if (!request || request.status !== 'pending') return res.status(404).json({ error: 'That request is gone.' });
  if (req.body?.approve === false) {
    request.status = 'denied';
    request.resolvedBy = req.player.id;
    feed(room, 'request', `Buy-in request turned down.`, request.playerId);
  } else {
    request.status = 'approved';
    request.resolvedBy = req.player.id;
    addBuyIn(room, {
      targetId: request.playerId, amount: request.amount, funding: request.funding,
      coveredBy: request.coveredBy, short: request.short, by: request.requestedBy,
      note: request.note, approvedBy: req.player.id
    });
  }
  push(room);
  res.json({ room: view(room, req.player) });
});

router.post('/:id/cashout', findRoom, A.requireAuth, (req, res) => {
  const room = req.room;
  const admin = A.isRoomAdmin(room, req.player);
  const targetId = req.body?.playerId || req.player.id;
  if (targetId !== req.player.id && !admin) {
    return res.status(403).json({ error: 'Only the room admin can cash someone else out.' });
  }
  if (room.status === 'ended') {
    return res.status(400).json({ error: 'This night is closed. Reopen it if something needs fixing.' });
  }
  const amount = L.round(Number(req.body?.amount));
  if (!(amount >= 0)) return res.status(400).json({ error: 'Count the chips and enter the total.' });
  const pot = L.potState(room);
  if (amount > pot.chipsInPlay + 0.009) {
    return res.status(400).json({ error: `There are only ${room.config.currency}${pot.chipsInPlay} in chips on the table. Recount.` });
  }
  const seg = currentSegment(room);
  room.ledger.push({
    id: id('e'), ts: Date.now(), type: 'cashout', playerId: targetId, amount,
    settled: req.body?.paidNow !== false, segmentId: seg?.id || null,
    createdBy: req.player.id, note: String(req.body?.note || '').slice(0, 80), voided: false
  });
  const p = db.players.find((x) => x.id === targetId);
  feed(room, 'cashout', `${p?.displayName} cashed out ${room.config.currency}${amount}.`, targetId, { amount });
  events.publish(room.id, 'sound', { event: 'cashout' });
  if (req.body?.seatOut) {
    const rp = room.players.find((x) => x.playerId === targetId);
    if (rp) { closeSeat(rp); rp.status = 'out'; rp.leftAt = Date.now(); }
  }
  push(room);
  res.json({ room: view(room, req.player) });
});

router.post('/:id/ledger/:eid/void', findRoom, A.requireAuth, needRoomAdmin, (req, res) => {
  const e = req.room.ledger.find((x) => x.id === req.params.eid);
  if (!e) return res.status(404).json({ error: 'No such entry.' });
  e.voided = !e.voided;
  e.voidedBy = e.voided ? req.player.id : null;
  e.voidedAt = e.voided ? Date.now() : null;
  feed(req.room, 'correction', e.voided ? 'An entry was struck out.' : 'An entry was put back.', e.playerId);
  logAudit(req.player.id, 'ledger.void', { roomId: req.room.id, entryId: e.id, voided: e.voided });
  push(req.room);
  res.json({ room: view(req.room, req.player) });
});

router.get('/:id/settlement', findRoom, A.requireAuthToRead, needRoomAccess, (req, res) => {
  const room = req.room;
  const carried = room.config.carryDebt
    ? db.balances.filter((b) => isMember(room, b.from) && isMember(room, b.to))
    : [];
  const result = L.settle(room, carried);
  res.json({
    ...result,
    names: Object.fromEntries(room.players.map((rp) => [
      rp.playerId, db.players.find((p) => p.id === rp.playerId)?.displayName || 'Guest'
    ])),
    handles: Object.fromEntries(room.players.map((rp) => [
      rp.playerId, db.players.find((p) => p.id === rp.playerId)?.payHandles || {}
    ])),
    currency: room.config.currency,
    carried
  });
});

/**
 * Close the night: freeze results, write them into lifetime stats, and either
 * record who still owes whom or clear the slate.
 */
router.post('/:id/end', findRoom, A.requireAuth, needRoomAdmin, (req, res) => {
  const room = req.room;
  if (room.status === 'ended') return res.status(400).json({ error: 'Already closed.' });
  const pot = L.potState(room);
  if (Math.abs(pot.chipsInPlay) > 0.009 && !req.body?.force) {
    return res.status(400).json({
      error: `${room.config.currency}${pot.chipsInPlay} in chips is still unaccounted for. Cash everyone out first.`,
      unreconciled: pot.chipsInPlay
    });
  }
  const carried = room.config.carryDebt
    ? db.balances.filter((b) => isMember(room, b.from) && isMember(room, b.to))
        .map((b) => ({ from: b.from, to: b.to, amount: b.amount }))
    : [];
  const settlement = L.settle(room, carried);

  /**
   * Anything the table did not hand over in cash becomes a standing balance.
   *
   * The settlement has already folded old debts into its figures, so those
   * payments are the *new total*, not an extra amount on top. Clearing what was
   * carried before applying them is what stops a debt being counted twice —
   * and counted twice again the night after that.
   *
   * Every change is written down as it happens so reopening can reverse exactly
   * these, rather than guessing from a recalculated settlement.
   */
  const appliedBalances = [];
  const applyBalance = (from, to, amount) => {
    if (Math.abs(amount) < 0.01) return;
    stats.adjustBalance(from, to, amount);
    appliedBalances.push({ from, to, amount });
  };
  if (req.body?.carryUnpaid !== false && room.config.carryDebt) {
    for (const b of carried) applyBalance(b.from, b.to, -b.amount);
    for (const pay of settlement.payments) applyBalance(pay.from, pay.to, pay.amount);
  }

  const games = [...new Set(room.segments.map((s) => s.game))];
  const byGameFor = (playerId) => {
    const out = {};
    for (const e of L.live(room)) {
      if (e.playerId !== playerId) continue;
      const seg = room.segments.find((s) => s.id === e.segmentId);
      if (!seg) continue;
      const delta = e.type === 'buyin' ? -e.amount : e.type === 'cashout' ? e.amount : 0;
      out[seg.game] = L.round((out[seg.game] || 0) + delta);
    }
    return out;
  };

  for (const rp of room.players) closeSeat(rp);
  room.status = 'ended';
  room.endedAt = Date.now();
  const session = {
    id: room.id,
    name: room.name,
    code: room.code,
    startedAt: room.startedAt || room.createdAt,
    endedAt: room.endedAt,
    durationMs: room.endedAt - (room.startedAt || room.createdAt),
    games,
    segments: room.segments,
    ledger: room.ledger,
    settlement,
    positions: settlement.positions.map((p) => ({
      ...p,
      byGame: byGameFor(p.playerId),
      shotsTaken: countShots(room, p.playerId).taken,
      shotsRefused: countShots(room, p.playerId).refused,
      seatedMs: seatedMs(room.players.find((rp) => rp.playerId === p.playerId))
    })),
    penalties: room.penalties,
    appliedBalances,
    shareToken: room.shareToken
  };
  db.sessions.push(session);
  db.save('sessions');
  feed(room, 'room', 'Game over. Settle up.');
  events.publish(room.id, 'sound', { event: 'game_end' });
  events.publish(room.id, 'ended', {});
  logAudit(req.player.id, 'room.ended', { roomId: room.id });
  push(room);
  res.json({ room: view(room, req.player), settlement });
});



/**
 * Undo a close. Somebody miscounted a stack and it only came out afterwards —
 * without this the only tool is a lifetime stat correction, which patches the
 * headline number but leaves that night's settlement and the debts it created
 * still wrong.
 *
 * Reverses the exact balances the close applied rather than recalculating, so
 * anything settled in the meantime is not silently trampled.
 */
router.post('/:id/reopen', findRoom, A.requireAuth, needRoomAdmin, (req, res) => {
  const room = req.room;
  if (room.status !== 'ended') return res.status(400).json({ error: 'This night is not closed.' });

  const at = db.sessions.findIndex((s) => s.id === room.id && s.endedAt === room.endedAt);
  if (at < 0) return res.status(400).json({ error: 'The record of that night is gone, so it cannot be reopened.' });
  const [session] = db.sessions.splice(at, 1);

  for (const b of session.appliedBalances || []) {
    stats.adjustBalance(b.from, b.to, -b.amount);
  }

  room.status = 'active';
  room.endedAt = null;
  for (const rp of room.players) openSeat(room, rp);
  db.save('sessions');
  feed(room, 'room', `${req.player.displayName} reopened the night to fix something.`, req.player.id);
  logAudit(req.player.id, 'room.reopened', {
    roomId: room.id,
    reason: String(req.body?.reason || '').slice(0, 120),
    balancesReversed: (session.appliedBalances || []).length
  });
  push(room);
  res.json({ room: view(room, req.player) });
});

// ── Money that leaves the chips behind ───────────────────────────────────────

/**
 * Pizza, drinks, tips, the host's cut. Kept apart from chips on purpose: chips
 * still have to reconcile at the end, and this money never was chips.
 */
router.post('/:id/expenses', findRoom, A.requireAuth, needRoomAdmin, (req, res) => {
  const room = req.room;
  if (room.status === 'ended') {
    return res.status(400).json({ error: 'This night is closed. Reopen it if something needs fixing.' });
  }
  const amount = L.round(Number(req.body?.amount));
  if (!(amount > 0)) return res.status(400).json({ error: 'Enter an amount above zero.' });

  const label = String(req.body?.label || '').trim().slice(0, 40);
  if (!label) return res.status(400).json({ error: 'Say what the money was for.' });

  const beneficiary = req.body?.beneficiary && req.body.beneficiary !== 'external'
    ? req.body.beneficiary : 'external';
  if (beneficiary !== 'external' && !isMember(room, beneficiary)) {
    return res.status(400).json({ error: 'That person is not at this table.' });
  }
  const fundedFrom = req.body?.fundedFrom || 'box';
  if (!['box', 'later'].includes(fundedFrom) && !isMember(room, fundedFrom)) {
    return res.status(400).json({ error: 'Pick who actually paid.' });
  }

  // Split between whoever was named, evenly, with the rounding remainder going
  // to the first person so the shares always add up to the exact amount.
  let among = Array.isArray(req.body?.among) && req.body.among.length
    ? req.body.among.filter((id) => isMember(room, id))
    : room.players.filter((p) => p.status !== 'removed').map((p) => p.playerId);
  among = [...new Set(among)];
  if (!among.length) return res.status(400).json({ error: 'Pick at least one person to split it between.' });

  const each = Math.floor((amount / among.length) * 100) / 100;
  const shares = among.map((playerId) => ({ playerId, amount: each }));
  shares[0].amount = L.round(amount - each * (among.length - 1));

  const entry = {
    id: id('e'), ts: Date.now(), type: 'expense', playerId: beneficiary === 'external' ? among[0] : beneficiary,
    amount, label, beneficiary, fundedFrom, shares,
    segmentId: currentSegment(room)?.id || null,
    createdBy: req.player.id, note: String(req.body?.note || '').slice(0, 80), voided: false
  };
  room.ledger.push(entry);

  const name = (x) => db.players.find((p) => p.id === x)?.displayName || 'someone';
  const who = beneficiary === 'external' ? '' : ` to ${name(beneficiary)}`;
  const cur = room.config.currency;
  feed(room, 'expense',
    `${label}: ${cur}${amount}${who}, split ${among.length} ${among.length === 1 ? 'way' : 'ways'} (${cur}${each} each).`,
    req.player.id, { amount });
  push(room);
  res.json({ room: view(room, req.player) });
});

// ── Seats and the deal ───────────────────────────────────────────────────────

router.post('/:id/seats', findRoom, A.requireAuth, needRoomAdmin, (req, res) => {
  const order = req.body?.order;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'Send the seats in the order you want them.' });
  const room = req.room;
  const known = new Set(room.players.map((p) => p.playerId));
  const clean = order.filter((pid) => known.has(pid));
  if (clean.length !== room.players.length) {
    return res.status(400).json({ error: 'That seating leaves someone out. Try again.' });
  }
  clean.forEach((pid, i) => {
    const rp = room.players.find((p) => p.playerId === pid);
    if (rp) rp.seat = i + 1;
  });
  room.players.sort((a, b) => a.seat - b.seat);
  push(room);
  res.json({ room: view(room, req.player) });
});

/** Pass the deal to the next person still sitting down. */
router.post('/:id/dealer', findRoom, A.requireAuth, needRoomAdmin, (req, res) => {
  const room = req.room;
  const seated = room.players
    .filter((p) => p.status === 'seated')
    .sort((a, b) => a.seat - b.seat);
  if (!seated.length) return res.status(400).json({ error: 'Nobody is sitting down.' });

  if (req.body?.playerId) {
    if (!seated.some((p) => p.playerId === req.body.playerId)) {
      return res.status(400).json({ error: 'They are not sitting down.' });
    }
    room.dealerId = req.body.playerId;
  } else {
    const at = seated.findIndex((p) => p.playerId === room.dealerId);
    room.dealerId = seated[(at + 1) % seated.length].playerId;
  }
  const name = db.players.find((p) => p.id === room.dealerId)?.displayName;
  feed(room, 'game', `${name} has the button.`, room.dealerId);
  push(room);
  res.json({ room: view(room, req.player) });
});

// ── The shot ─────────────────────────────────────────────────────────────────

/**
 * Anyone at the table can call it on anyone. The person called has two ways
 * out and both get counted: take it, or don't and post the photo.
 */
router.post('/:id/shots', findRoom, A.requireAuth, (req, res) => {
  const room = req.room;
  if (!room.config.shotsEnabled) return res.status(400).json({ error: 'Shots are switched off at this table.' });
  if (!isMember(room, req.player.id)) return res.status(403).json({ error: 'Only people at the table can call it.' });
  const target = req.body?.playerId;
  if (!isMember(room, target)) return res.status(400).json({ error: 'They are not at this table.' });
  if (room.penalties.some((p) => p.playerId === target && p.status === 'pending')) {
    return res.status(400).json({ error: 'They already owe one. Let them settle it first.' });
  }
  const penalty = {
    id: id('sh'), playerId: target, calledBy: req.player.id, ts: Date.now(),
    reason: String(req.body?.reason || '').slice(0, 60),
    status: 'pending', resolvedAt: null, photoId: null
  };
  room.penalties.push(penalty);
  const name = (x) => db.players.find((p) => p.id === x)?.displayName || 'Someone';
  feed(room, 'shot', `${name(req.player.id)} called a ${room.config.shotName.toLowerCase()} on ${name(target)}${penalty.reason ? ` — ${penalty.reason}` : ''}.`, target);
  events.publish(room.id, 'sound', { event: 'shot' });
  events.publish(room.id, 'shot_called', { playerId: target, name: name(target), by: name(req.player.id), reason: penalty.reason });
  push(room);
  res.json({ room: view(room, req.player) });
});

router.post('/:id/shots/:sid', findRoom, A.requireAuth, (req, res) => {
  const room = req.room;
  const penalty = room.penalties.find((p) => p.id === req.params.sid);
  if (!penalty || penalty.status !== 'pending') return res.status(404).json({ error: 'Nothing outstanding there.' });
  if (penalty.playerId !== req.player.id && !A.isRoomAdmin(room, req.player)) {
    return res.status(403).json({ error: 'Only they can answer for it.' });
  }
  const name = db.players.find((p) => p.id === penalty.playerId)?.displayName || 'Someone';
  const shot = room.config.shotName.toLowerCase();

  if (req.body?.took) {
    penalty.status = 'taken';
    penalty.resolvedAt = Date.now();
    feed(room, 'shot', `${name} took the ${shot}.`, penalty.playerId);
    events.publish(room.id, 'sound', { event: 'shot_taken' });
    push(room);
    return res.json({ room: view(room, req.player) });
  }

  // Refusing costs a photo, and the photo is the whole point.
  try {
    const saved = media.saveDataUrl('photos', req.body?.dataUrl);
    const photo = {
      id: id('ph'), url: saved.url, by: penalty.playerId, ts: Date.now(),
      caption: `${name} would not take the ${shot}`, penalty: true
    };
    room.photos.unshift(photo);
    penalty.status = 'refused';
    penalty.resolvedAt = Date.now();
    penalty.photoId = photo.id;
    feed(room, 'shot', `${name} refused, so here they are with it.`, penalty.playerId, { photoId: photo.id });
    events.publish(room.id, 'sound', { event: 'shot_refused' });
    events.publish(room.id, 'photo', photo);
    push(room);
    res.json({ room: view(room, req.player), photo });
  } catch (err) {
    res.status(400).json({ error: `${err.message} No photo, no way out.` });
  }
});

// ── Table extras ─────────────────────────────────────────────────────────────

router.get('/:id/qr', findRoom, A.requireAuthToRead, needRoomAccess, async (req, res) => {
  // Prefer the HTTPS link: it is the only one where alerts and home-screen
  // install work for anyone who is not sitting at the host computer.
  const base = req.query.base
    || config.publicUrl
    || req.app.get('secureBase')
    || `${req.protocol}://${req.get('host')}`;
  const url = `${base}/#/room/${req.room.code}`;
  try {
    const dataUrl = await QR.toDataURL(url, { margin: 1, width: 480, color: { dark: '#12211c', light: '#f5f0e4' } });
    res.json({ url, dataUrl, code: req.room.code, secure: url.startsWith('https:') });
  } catch {
    res.status(500).json({ error: 'Could not draw the QR code.' });
  }
});

router.post('/:id/announce', findRoom, A.requireAuth, (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 140);
  if (!text) return res.status(400).json({ error: 'Say something first.' });
  if (!isMember(req.room, req.player.id) && !A.isRoomAdmin(req.room, req.player)) {
    return res.status(403).json({ error: 'Only people at the table can call out.' });
  }
  const item = feed(req.room, 'announce', text, req.player.id);
  events.publish(req.room.id, 'announce', { ...item, by: req.player.displayName, soundId: req.body?.soundId || null });
  db.save('rooms');
  res.json({ ok: true });
});

router.post('/:id/photos', findRoom, A.requireAuth, (req, res) => {
  if (!isMember(req.room, req.player.id)) return res.status(403).json({ error: 'Only people at the table can post photos.' });
  try {
    const saved = media.saveDataUrl('photos', req.body?.dataUrl);
    const photo = {
      id: id('ph'), url: saved.url, by: req.player.id, ts: Date.now(),
      caption: String(req.body?.caption || '').slice(0, 100)
    };
    req.room.photos.unshift(photo);
    if (req.room.photos.length > 200) {
      const dropped = req.room.photos.splice(200);
      dropped.forEach((p) => media.remove(p.url));
    }
    feed(req.room, 'photo', `${req.player.displayName} added a photo.`, req.player.id, { photoId: photo.id });
    events.publish(req.room.id, 'photo', photo);
    push(req.room);
    res.json({ photo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id/photos/:pid', findRoom, A.requireAuth, (req, res) => {
  const room = req.room;
  const i = room.photos.findIndex((p) => p.id === req.params.pid);
  if (i < 0) return res.status(404).json({ error: 'That photo is gone.' });
  if (room.photos[i].by !== req.player.id && !A.isRoomAdmin(room, req.player)) {
    return res.status(403).json({ error: 'You can only delete your own photos.' });
  }
  media.remove(room.photos[i].url);
  room.photos.splice(i, 1);
  push(room);
  res.json({ ok: true });
});

/** Map an uploaded sound to a table event. */
router.put('/:id/sounds', findRoom, A.requireAuth, needRoomAdmin, (req, res) => {
  const { event, soundId } = req.body || {};
  const allowed = ['buyin', 'cashout', 'request', 'game_start', 'game_end', 'game_change', 'announce', 'join', 'settle'];
  if (!allowed.includes(event)) return res.status(400).json({ error: 'Unknown table event.' });
  if (soundId && !db.sounds.some((s) => s.id === soundId)) {
    return res.status(404).json({ error: 'That sound is not in the library.' });
  }
  if (soundId) req.room.sounds[event] = soundId; else delete req.room.sounds[event];
  push(req.room);
  res.json({ sounds: req.room.sounds });
});

router.post('/:id/share', findRoom, A.requireAuth, needRoomAdmin, (req, res) => {
  req.room.shareToken = req.body?.enabled === false ? null : (req.room.shareToken || crypto.randomBytes(9).toString('hex'));
  push(req.room);
  res.json({ shareToken: req.room.shareToken });
});

router.get('/:id/stream', findRoom, A.requireAuthToRead, needRoomAccess, (req, res) => {
  events.subscribe(req.room.id, res);
});

router.get('/:id/export.csv', findRoom, A.requireAuthToRead, needRoomAccess, (req, res) => {
  const room = req.room;
  const name = (pid) => (db.players.find((p) => p.id === pid)?.displayName || '').replace(/"/g, "'");
  const rows = [['time', 'type', 'player', 'amount', 'funding', 'counterparty', 'game', 'note', 'voided']];
  for (const e of room.ledger) {
    rows.push([
      new Date(e.ts).toISOString(), e.type, name(e.playerId), e.amount ?? '',
      e.funding || '', name(e.coveredBy || e.counterparty) || '',
      G.label(room.segments.find((s) => s.id === e.segmentId)?.game || ''),
      e.note || '', e.voided ? 'yes' : ''
    ]);
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${room.code}-ledger.csv"`);
  res.send(rows.map((r) => r.map((c) => `"${String(c)}"`).join(',')).join('\n'));
});

module.exports = { router };
