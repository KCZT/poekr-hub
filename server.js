'use strict';
const express = require('express');
const https = require('https');
const path = require('path');
const os = require('os');
const tls = require('./src/tls');
const fs = require('fs');
const { db } = require('./src/store');
const config = require('./src/config');
const G = require('./src/games');
const { router: authRoutes } = require('./src/routes/auth');
const playerRoutes = require('./src/routes/players');
const { router: roomRoutes } = require('./src/routes/rooms');
const adminRoutes = require('./src/routes/admin');
const { sounds, share, leaderboardShare } = require('./src/routes/extras');

const app = express();
const PORT = config.port;
const SECURE_PORT = config.securePort;
let secureReady = false;

app.disable('x-powered-by');
// Behind Caddy the client's address and scheme arrive in headers. Without this,
// req.secure reads false and every visitor looks like the proxy to the rate
// limiter, which would give the whole internet one shared budget of guesses.
if (config.trustProxy) app.set('trust proxy', config.trustProxy);
app.use(express.json({ limit: '8mb' }));

/**
 * The mark and the manifest are served rather than shipped as files, so that
 * changing the name or logo in the admin area reaches the browser tab, the
 * home-screen icon and the notification badge without anyone editing anything.
 */
app.get('/brand/icon', (_req, res) => {
  const custom = db.settings.logo;
  if (custom) {
    const file = path.join(process.env.POKERHUB_UPLOADS
      ? path.join(process.env.POKERHUB_UPLOADS, '..')
      : __dirname, custom.replace(/^\//, ''));
    if (fs.existsSync(file)) {
      res.set('Content-Type', db.settings.logoMime || 'image/png');
      res.set('Cache-Control', 'no-cache');
      return res.sendFile(file);
    }
  }
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'no-cache');
  return res.sendFile(path.join(__dirname, 'public', 'icon.svg'));
});

/** Home screens have little room, so shorten on a word rather than mid-syllable. */
function shortName(name) {
  if (name.length <= 15) return name;
  const words = name.split(/\s+/);
  let out = words.shift() || name;
  for (const w of words) {
    if (`${out} ${w}`.length > 15) break;
    out += ` ${w}`;
  }
  return out.length > 15 ? out.slice(0, 15).trim() : out;
}

app.get('/manifest.json', (_req, res) => {
  const name = db.settings.siteName || 'Poker Hub';
  res.set('Cache-Control', 'no-cache');
  res.json({
    name,
    short_name: shortName(name),
    description: 'Track buy-ins, cash-outs and who owes who at your home poker game.',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0d211c',
    theme_color: '#0d211c',
    icons: [{
      src: '/brand/icon',
      sizes: 'any',
      type: db.settings.logo ? (db.settings.logoMime || 'image/png') : 'image/svg+xml',
      purpose: 'any maskable'
    }]
  });
});

app.use('/uploads', express.static(process.env.POKERHUB_UPLOADS || path.join(__dirname, 'uploads'),
  { maxAge: '7d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/api/bootstrap', (req, res) => {
  res.json({
    siteName: db.settings.siteName,
    logo: '/brand/icon',
    hasCustomLogo: !!db.settings.logo,
    currency: db.settings.currency,
    allowSelfSignup: db.settings.allowSelfSignup,
    needsSetup: db.players.length === 0,
    games: Object.fromEntries(Object.entries(G.GAMES).map(([k, v]) => [k, {
      name: v.name, short: v.short, kind: v.kind, blurb: v.blurb, fields: v.fields
    }])),
    hosted: config.hosted,
    allowPasswordlessAccounts: config.allowPasswordlessAccounts,
    networkUrl: config.publicUrl || `http://${localIP()}:${PORT}`,
    // Same machine, secure port. Service workers, home-screen install and
    // alerts only exist for the browser on this one. Derived from the request
    // so it stays right behind a proxy or on a non-default port.
    secureUrl: secureBase(req),
    secureNetworkUrl: config.publicUrl || (secureReady ? `https://${localIP()}:${SECURE_PORT}` : null),
    leaderboardShared: !!db.settings.leaderboardToken,
    leaderboardToken: db.settings.leaderboardToken || null
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/players', playerRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/leaderboard-share', leaderboardShare);
app.use('/api/sounds', sounds);
app.use('/api/share', share);

// Public share pages render from one file; the token is read client-side.
app.get(['/s/:kind/:token'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'No such endpoint.' }));

// Client-side routing: anything else gets the app shell.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/uploads')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  const tooBig = err?.type === 'entity.too.large';
  console.error('[error]', err.message);
  res.status(tooBig ? 413 : 500).json({
    error: tooBig ? 'That file is too big to upload.' : 'Something broke on the server. Try again.'
  });
});

/** The https address for whoever is asking, or null if there is not one. */
function secureBase(req) {
  if (config.publicUrl) return config.publicUrl.startsWith('https://') ? config.publicUrl : null;
  if (req.secure) {
    const port = req.socket.localPort;
    return `https://${req.hostname}${port && port !== 443 ? `:${port}` : ''}`;
  }
  return secureReady ? `https://${req.hostname}:${SECURE_PORT}` : null;
}

function localIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

async function start() {
  const ip = localIP();
  app.listen(PORT, config.bind);

  if (config.hosted) return announceHosted();

  const cert = config.selfSignedTls ? await tls.ensure() : null;
  if (cert) {
    await new Promise((resolve) => {
      https.createServer({ key: cert.key, cert: cert.cert }, app)
        .listen(SECURE_PORT, '0.0.0.0', () => {
          secureReady = true;
          app.set('secureBase', `https://${ip}:${SECURE_PORT}`);
          resolve();
        })
        .on('error', resolve);
    });
  }

  console.log('');
  console.log(`  ${db.settings.siteName} is up.`);
  console.log(`  This computer   http://localhost:${PORT}`);
  if (secureReady) {
    console.log(`  Everyone else   https://${ip}:${SECURE_PORT}`);
    console.log('');
    console.log('  That link is the one to share. Phones will warn once that the');
    console.log('  connection is not private — that is expected, because the');
    console.log('  certificate is made by this computer rather than bought.');
    console.log('  Tap through it and the app can send alerts and install to the');
    console.log('  home screen. Without it, neither works away from this machine.');
    console.log(`  Plain link if you need it: http://${ip}:${PORT}`);
  } else {
    console.log(`  Everyone else   http://${ip}:${PORT}`);
    console.log('');
    console.log('  Running without HTTPS, so alerts and home-screen install will');
    console.log('  not work on other people\'s phones. Everything else is fine.');
  }
  if (db.players.length === 0) {
    console.log('');
    console.log('  First account created becomes the poker admin.');
  }
  console.log('');
}

function announceHosted() {
  const open = db.players.filter((p) => !p.passwordHash && !p.disabled && !p.isGuest);
  const openAdmins = open.filter((p) => p.role === 'site_admin');
  console.log('');
  console.log(`  ${db.settings.siteName} is up, hosted.`);
  console.log(`  Address        ${config.publicUrl}`);
  console.log(`  Listening on   ${config.bind}:${PORT}  (your proxy should point here)`);
  console.log('');
  console.log('  Reading a table needs a sign-in, because this is a public');
  console.log('  address rather than your wifi.');

  if (config.allowPasswordlessAccounts) {
    console.log('');
    console.log('  Accounts may have no password, and anyone who finds this');
    console.log('  address can sign in as one by tapping the name. That is the');
    console.log('  trade you have chosen; REQUIRE_PASSWORDS=1 turns it off.');
    if (openAdmins.length) {
      console.log('');
      const who = openAdmins.map((p) => p.username).join(', ');
      console.log('');
      console.log(`  Worth knowing: ${who} ${openAdmins.length === 1 ? 'is a poker admin' : 'are poker admins'}`);
      console.log('  with no password, so anyone at all can manage every');
      console.log('  account and download a backup of the lot.');
      console.log('  Give them one with:  npm run set-password <username>');
    }
  } else {
    console.log('  Accounts need a password here, so one without cannot sign in.');
    if (open.length) {
      console.log('');
      console.log(`  ${open.length} account${open.length === 1 ? '' : 's'} here ${open.length === 1 ? 'has' : 'have'} no password and cannot sign in:`);
      for (const p of open.slice(0, 8)) {
        console.log(`    ${p.username}${p.role === 'site_admin' ? '  (poker admin)' : ''}`);
      }
      if (open.length > 8) console.log(`    …and ${open.length - 8} more`);
      console.log('');
      console.log('  Give them one with:  npm run set-password <username>');
    }
  }

  if (db.players.length === 0) {
    console.log('');
    console.log('  No accounts yet. The first one created becomes the poker admin,');
    console.log('  so make it yours before sharing the address.');
  }
  console.log('');
}

if (require.main === module) start();

module.exports = { app };
