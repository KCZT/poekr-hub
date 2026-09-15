const TOKEN_KEY = 'pokerhub.token';

export const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  me: null,
  boot: null,
  room: null,
  roomId: null,
  players: [],
  sounds: [],
  soundSlots: [],
  muted: localStorage.getItem('pokerhub.muted') === '1'
};

export function setToken(t) {
  state.token = t;
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (raw) return res;
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(data.error || 'That did not work. Try again.', res.status);
  return data;
}

export const money = (n, cur = state.room?.config?.currency || state.boot?.currency || '$') => {
  const v = Number(n || 0);
  const s = Math.abs(v) % 1 === 0 ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(2);
  return `${v < 0 ? '−' : ''}${cur}${s}`;
};

export const signed = (n, cur) => (Number(n) > 0 ? `+${money(n, cur)}` : money(n, cur));

export function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Shrink a picked image in the browser so uploads stay small.
 *
 * Phone cameras record which way up the photo is in EXIF rather than rotating
 * the pixels, and drawing straight to a canvas throws that away — which is how
 * you end up with a gallery full of sideways photos. createImageBitmap can
 * apply it; the older path is kept for browsers that cannot.
 */
export async function readImage(file, max = 512) {
  if (!file) throw new Error('Pick a file first.');
  if (!file.type.startsWith('image/')) throw new Error('That is not an image.');

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bitmap.width * scale);
      c.height = Math.round(bitmap.height * scale);
      c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
      bitmap.close?.();
      return c.toDataURL('image/jpeg', 0.85);
    } catch { /* fall through to the older path */ }
  }
  return legacyReadImage(file, max);
}

function legacyReadImage(file, max) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not open that image.'));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Fits a picked image inside a transparent square and returns a PNG, so a logo
 * behaves whatever shape it arrived as. SVGs are passed through untouched —
 * they scale better than anything a canvas would produce.
 */
export async function readSquareImage(file, size = 512) {
  if (!file) throw new Error('Pick a file first.');
  if (!file.type.startsWith('image/')) throw new Error('That is not an image.');
  if (file.type === 'image/svg+xml') {
    if (file.size > 1e6) throw new Error('Keep it under 1MB.');
    return readFile(file);
  }
  const bitmap = typeof createImageBitmap === 'function'
    ? await createImageBitmap(file, { imageOrientation: 'from-image' })
    : null;
  if (!bitmap) return readImage(file, size);
  const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  c.getContext('2d').drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  bitmap.close?.();
  return c.toDataURL('image/png');
}

export function readFile(file, maxBytes) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('Pick a file first.'));
    if (maxBytes && file.size > maxBytes) {
      return reject(new Error(`Keep it under ${Math.round(maxBytes / 1e6)}MB.`));
    }
    const r = new FileReader();
    r.onerror = () => reject(new Error('Could not read that file.'));
    r.onload = () => resolve(r.result);
    r.readAsDataURL(file);
  });
}
