'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', 'uploads');
const KINDS = {
  avatars: { max: 1.5e6, types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
  brand: { max: 1e6, types: ['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp'] },
  photos: { max: 6e6, types: ['image/png', 'image/jpeg', 'image/webp'] },
  sounds: { max: 3e6, types: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/x-m4a', 'audio/aac'] }
};
const EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
  'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac'
};

for (const kind of Object.keys(KINDS)) {
  const dir = path.join(ROOT, kind);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Accepts a data URL from the browser. The client shrinks images on a canvas
 * before sending, so these stay small enough to keep in a folder next to the
 * data files — no object store, no second service to run on poker night.
 */
function saveDataUrl(kind, dataUrl) {
  const rules = KINDS[kind];
  if (!rules) throw new Error('Unknown upload type.');
  const m = /^data:([\w.+/-]+);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m) throw new Error('That file did not come through. Try again.');
  const [, mime, b64] = m;
  if (!rules.types.includes(mime)) {
    throw new Error(kind === 'sounds'
      ? 'Use an mp3, wav, m4a or ogg file.'
      : 'Use a PNG, JPEG or WebP image.');
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > rules.max) {
    throw new Error(`That file is too big. Keep it under ${Math.round(rules.max / 1e6)}MB.`);
  }
  const name = `${crypto.randomBytes(10).toString('hex')}.${EXT[mime] || 'bin'}`;
  fs.writeFileSync(path.join(ROOT, kind, name), buf);
  return { url: `/uploads/${kind}/${name}`, bytes: buf.length, mime };
}

function remove(url) {
  if (!url || typeof url !== 'string') return;
  const m = /^\/uploads\/(avatars|photos|sounds|brand)\/([A-Za-z0-9._-]+)$/.exec(url);
  if (!m) return;
  const f = path.join(ROOT, m[1], m[2]);
  if (fs.existsSync(f)) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
}

module.exports = { saveDataUrl, remove };
