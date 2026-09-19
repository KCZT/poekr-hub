'use strict';
/**
 * Browsers gate service workers, home-screen install and notifications behind a
 * "secure context". http://localhost counts; http://192.168.1.24 does not — and
 * that second one is what everybody's phone is actually using. So the app makes
 * itself a certificate on first run and serves HTTPS alongside plain HTTP.
 *
 * It is self-signed, so each phone shows a warning once and has to be told to
 * carry on. There is no way around that without a real domain, and the trade is
 * worth it: without HTTPS the alerts simply never fire for anyone but the host.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(process.env.POKERHUB_DATA || path.join(__dirname, '..', 'data'), 'cert');
const KEY = path.join(DIR, 'key.pem');
const CERT = path.join(DIR, 'cert.pem');
const META = path.join(DIR, 'hosts.json');

/** Every IPv4 address this machine answers on. */
function localIPs() {
  const out = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function readMeta() {
  try { return JSON.parse(fs.readFileSync(META, 'utf8')); } catch { return null; }
}

/**
 * Returns {key, cert, hosts} or null if a certificate could not be made.
 * Regenerates when the machine has moved to a network the old one does not cover.
 */
async function ensure() {
  const ips = localIPs();
  const meta = readMeta();
  const covered = meta && ips.every((ip) => meta.hosts.includes(ip));

  if (covered && fs.existsSync(KEY) && fs.existsSync(CERT)) {
    try {
      return { key: fs.readFileSync(KEY, 'utf8'), cert: fs.readFileSync(CERT, 'utf8'), hosts: meta.hosts, reused: true };
    } catch { /* fall through and rebuild */ }
  }

  let selfsigned;
  try {
    selfsigned = require('selfsigned');
  } catch {
    return null; // Dependency missing: the app still runs, just over HTTP.
  }

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: os.hostname() },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip }))
  ];

  try {
    const pems = await selfsigned.generate(
      [{ name: 'commonName', value: os.hostname() || 'poker-hub' }],
      {
        days: 3650,
        keySize: 2048,
        algorithm: 'sha256',
        extensions: [
          { name: 'basicConstraints', cA: false },
          { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
          { name: 'extKeyUsage', serverAuth: true },
          { name: 'subjectAltName', altNames }
        ]
      }
    );
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(KEY, pems.private, { mode: 0o600 });
    fs.writeFileSync(CERT, pems.cert);
    fs.writeFileSync(META, JSON.stringify({ hosts: ips, madeAt: Date.now() }, null, 2));
    return { key: pems.private, cert: pems.cert, hosts: ips, reused: false };
  } catch {
    return null;
  }
}

module.exports = { ensure, DIR };
