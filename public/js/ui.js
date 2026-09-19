import { state } from './api.js';

/** Tiny hyperscript. Keeps views readable without a framework. */
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(3)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/**
 * @param {string} message
 * @param {string} kind  '' | 'err' | 'win'
 * @param {{label: string, onClick: Function}} [action]  sticks around longer
 */
export function toast(message, kind = '', action = null) {
  const wrap = document.getElementById('toasts');
  const el = h('div', { class: `toast ${kind}`, role: 'status' },
    h('span', { class: 'grow' }, message),
    action
      ? h('button', {
        class: 'btn btn-sm',
        style: { marginLeft: '10px', flex: 'none' },
        onClick: () => { el.remove(); action.onClick(); }
      }, action.label)
      : null);
  if (action) el.classList.add('toast-action');
  wrap.append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, action ? 9000 : kind === 'err' ? 4200 : 2600);
}

const SUIT = { spade: '♠', heart: '♥', club: '♣', diamond: '♦' };
export const suitChar = (s) => SUIT[s] || '♠';

export function avatar(p, cls = '') {
  const initials = String(p?.displayName || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  if (p?.avatar) {
    return h('img', { class: `avatar ${cls}`, src: p.avatar, alt: '', loading: 'lazy' });
  }
  return h('div', { class: `avatar ${cls}`, style: { background: p?.accent || '#d2a63c' }, 'aria-hidden': 'true' }, initials);
}

/** Bottom sheet on phones, centred dialog on desktop. Returns a close fn. */
export function sheet(build, { onClose, card = false } = {}) {
  const layer = document.getElementById('layer');
  const box = h('div', { class: `sheet ${card ? 'sheet-card' : ''}`, role: 'dialog', 'aria-modal': 'true' });
  const scrim = h('div', { class: 'scrim' }, box);
  const close = () => {
    scrim.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  document.addEventListener('keydown', onKey);
  box.append(...[build(close)].flat().filter(Boolean));
  layer.append(scrim);
  box.querySelector('input, select, textarea, button')?.focus({ preventScroll: true });
  return close;
}

export function confirmSheet({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const close = sheet((dismiss) => [
      h('h2', {}, title),
      body ? h('p', { class: 'sheet-sub' }, body) : null,
      h('div', { class: 'sheet-actions' },
        h('button', { class: 'btn', onClick: () => { done(false); dismiss(); } }, 'Cancel'),
        h('button', {
          class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
          onClick: () => { done(true); dismiss(); }
        }, confirmLabel))
    ], { onClose: () => done(false) });
    void close;
  });
}

/** Numeric entry with quick-tap presets — faster than a keyboard at a table. */
export function amountField(label, value, presets = [], hint) {
  const input = h('input', { type: 'number', inputmode: 'decimal', step: '0.01', min: '0', value: String(value ?? '') });
  const chips = h('div', { class: 'chip-row', style: { marginTop: '8px' } },
    presets.map((p) => h('button', {
      type: 'button', class: 'chip',
      onClick: () => { input.value = String(p); input.dispatchEvent(new Event('input')); }
    }, String(p))));
  const wrap = h('label', { class: 'field' },
    h('span', {}, label, hint ? h('span', { class: 'hint' }, ` — ${hint}`) : null),
    input, presets.length ? chips : null);
  wrap.input = input;
  return wrap;
}

// ── Sound ────────────────────────────────────────────────────────────────

const cache = new Map();
let ctx = null;

/** Fallback blips so the app is audible before anyone uploads anything. */
function blip(kind) {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const notes = {
      buyin: [440, 660], cashout: [660, 880], request: [520, 400],
      game_start: [392, 523, 659], game_end: [523, 392, 262],
      game_change: [587, 784], announce: [880], join: [523, 659], settle: [659, 523]
    }[kind] || [523];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.11;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.25);
    });
  } catch { /* audio unavailable */ }
}

export function playSound(eventKey) {
  if (state.muted) return;
  const soundId = state.room?.sounds?.[eventKey];
  const sound = soundId && state.sounds.find((s) => s.id === soundId);
  if (!sound) return blip(eventKey);
  playUrl(sound.url);
}

export function playUrl(url) {
  if (state.muted || !url) return;
  let a = cache.get(url);
  if (!a) { a = new Audio(url); cache.set(url, a); }
  a.volume = state.me?.settings?.soundVolume ?? 0.7;
  a.currentTime = 0;
  a.play().catch(() => { /* needs a tap first */ });
}

export function speak(text) {
  if (state.muted || !window.speechSynthesis) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    u.volume = state.me?.settings?.soundVolume ?? 0.7;
    speechSynthesis.speak(u);
  } catch { /* no voices */ }
}

// ── Keep the screen on while a game is running ───────────────────────────

let wakeLock = null;
export async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) {
      wakeLock = wakeLock || await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && !wakeLock) {
          try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* denied */ }
        }
      }, { once: true });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not supported */ }
}

export async function share(title, url, text) {
  if (navigator.share) {
    try { await navigator.share({ title, url, text }); return true; } catch { return false; }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied.', 'win');
    return true;
  } catch {
    toast(url);
    return false;
  }
}

export function empty(message, action) {
  return h('div', { class: 'empty' }, h('p', {}, message), action || null);
}
