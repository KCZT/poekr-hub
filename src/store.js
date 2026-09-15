'use strict';
/**
 * Tiny JSON-file store. One file per collection, atomic writes, debounced flush.
 * No native deps so the app runs anywhere Node runs (including a laptop on the
 * kitchen table with no internet).
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const SHAPES = {
  players: [],
  rooms: [],
  sessions: [],   // archived rooms, kept for lifetime stats
  balances: [],   // { a, b, amount }  amount>0 => a owes b. a<b lexically.
  audit: [],
  shares: [],
  tokens: [],   // { hash, playerId, created }  sign-ins that survive a restart
  settings: {
    siteName: 'Poker Hub',
    logo: null,       // uploaded by the poker admin; falls back to the bundled mark
    logoMime: null,
    currency: '$',
    allowSelfSignup: true,
    defaultBuyIn: 20,
    minBuyIn: 5,
    buyInIncrement: 5,
    carryDebtBetweenSessions: true
  },
  sounds: []      // custom uploaded audio effects
};

const cache = {};
const dirty = new Set();
let timer = null;

function file(name) { return path.join(DATA_DIR, `${name}.json`); }

function load(name) {
  if (cache[name] !== undefined) return cache[name];
  const f = file(name);
  if (fs.existsSync(f)) {
    try {
      cache[name] = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (err) {
      // Never lose data to a half-written file: park it and start clean.
      fs.renameSync(f, `${f}.corrupt-${Date.now()}`);
      cache[name] = clone(SHAPES[name]);
    }
  } else {
    cache[name] = clone(SHAPES[name]);
  }
  if (name === 'settings') cache[name] = { ...SHAPES.settings, ...cache[name] };
  return cache[name];
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function flushOne(name) {
  const f = file(name);
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache[name], null, 2));
  fs.renameSync(tmp, f);
}

function flush() {
  for (const name of dirty) flushOne(name);
  dirty.clear();
  timer = null;
}

function save(name) {
  dirty.add(name);
  if (!timer) timer = setTimeout(flush, 120);
}

// Write everything still pending before the process dies.
function flushNow() { if (timer) { clearTimeout(timer); } flush(); }
process.on('exit', flushNow);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { flushNow(); process.exit(0); });
}

const db = {
  get players() { return load('players'); },
  get rooms() { return load('rooms'); },
  get sessions() { return load('sessions'); },
  get balances() { return load('balances'); },
  get audit() { return load('audit'); },
  get shares() { return load('shares'); },
  get tokens() { return load('tokens'); },
  get settings() { return load('settings'); },
  get sounds() { return load('sounds'); },
  save,
  flushNow,
  DATA_DIR
};

/** Append an audit entry. Every privileged action lands here. */
function logAudit(actorId, action, detail) {
  const entry = {
    id: id('a'),
    ts: Date.now(),
    actorId,
    action,
    detail: detail || {}
  };
  db.audit.unshift(entry);
  if (db.audit.length > 5000) db.audit.length = 5000;
  save('audit');
  return entry;
}

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = { db, logAudit, id };
