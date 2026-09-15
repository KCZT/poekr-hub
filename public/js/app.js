import { api, state, setToken } from './api.js';
import { h, toast } from './ui.js';
import { authView } from './views/auth.js';
import { lobbyView } from './views/lobby.js';
import { roomView, leaveRoom } from './views/room.js';
import { boardView } from './views/board.js';
import { meView } from './views/me.js';
import { adminView } from './views/admin.js';

const view = document.getElementById('view');
const appbar = document.getElementById('appbar');
const tabbar = document.getElementById('tabbar');
const titleEl = document.getElementById('title');
const subEl = document.getElementById('subtitle');
const backBtn = document.getElementById('backBtn');
const soundBtn = document.getElementById('soundBtn');

const TABS = [
  { path: '/', glyph: '\u2660', label: 'Tables' },
  { path: '/board', glyph: '\u2666', label: 'Standings' },
  { path: '/me', glyph: '\u2665', label: 'You' },
  { path: '/admin', glyph: '\u2663', label: 'Admin', adminOnly: true }
];

function go(path) {
  if (location.hash.slice(1) === path) route();
  else location.hash = path;
}

function setHeader(title, sub) {
  titleEl.firstChild.nodeValue = title;
  subEl.textContent = sub || '';
}

function paintTabs(current) {
  tabbar.replaceChildren(...TABS
    .filter((t) => !t.adminOnly || state.me?.role === 'site_admin')
    .map((t) => h('button', {
      onClick: () => go(t.path),
      'aria-current': current === t.path ? 'page' : null
    }, h('span', { class: 'g', 'aria-hidden': 'true' }, t.glyph), t.label)));
}

async function route() {
  const path = location.hash.slice(1) || '/';

  if (!state.me) {
    appbar.hidden = true;
    tabbar.hidden = true;
    return authView(view, { onDone: async () => { await loadSession(); go('/'); } });
  }

  appbar.hidden = false;
  tabbar.hidden = false;
  backBtn.hidden = !path.startsWith('/room/');
  window.scrollTo(0, 0);

  if (!path.startsWith('/room/')) leaveRoom();

  try {
    if (path.startsWith('/room/')) {
      paintTabs('/');
      await roomView(view, { code: path.split('/')[2], go, setHeader });
    } else if (path === '/board') {
      paintTabs('/board');
      setHeader(state.boot?.siteName || 'Poker Hub', 'How everyone is doing');
      await boardView(view);
    } else if (path === '/me') {
      paintTabs('/me');
      setHeader('You', state.me.displayName);
      await meView(view, { go, reload: route });
    } else if (path === '/admin') {
      if (state.me.role !== 'site_admin') return go('/');
      paintTabs('/admin');
      setHeader('Admin', 'Accounts, stats and site settings');
      await adminView(view, { reload: route });
    } else {
      paintTabs('/');
      setHeader(state.boot?.siteName || 'Poker Hub', state.boot?.networkUrl || '');
      await lobbyView(view, { go });
    }
  } catch (e) {
    view.replaceChildren(h('div', { class: 'empty' }, e.message || 'Something went wrong.'));
  }
  view.focus({ preventScroll: true });
}

async function loadSession() {
  try {
    const r = await api('/auth/me');
    state.me = r.player;
  } catch {
    setToken(null);
    state.me = null;
  }
  if (state.me) {
    const [players, sounds] = await Promise.allSettled([api('/players'), api('/sounds')]);
    if (players.status === 'fulfilled') state.players = players.value.players;
    if (sounds.status === 'fulfilled') {
      state.sounds = sounds.value.sounds;
      state.soundSlots = sounds.value.slots;
    }
  }
}

function paintSoundBtn() {
  soundBtn.textContent = state.muted ? '\u{1F507}' : '\u{1F50A}';
  soundBtn.setAttribute('aria-label', state.muted ? 'Turn sounds on' : 'Mute sounds');
  soundBtn.classList.toggle('on', !state.muted);
}

soundBtn.addEventListener('click', () => {
  state.muted = !state.muted;
  localStorage.setItem('pokerhub.muted', state.muted ? '1' : '0');
  paintSoundBtn();
  toast(state.muted ? 'Sounds off.' : 'Sounds on.');
});

backBtn.addEventListener('click', () => go('/'));
window.addEventListener('hashchange', route);

(async function boot() {
  try {
    state.boot = await api('/bootstrap');
  } catch {
    view.replaceChildren(h('div', { class: 'empty' }, 'Cannot reach the table. Is the host still running the app?'));
    return;
  }
  document.title = state.boot.siteName || 'Poker Hub';
  paintSoundBtn();
  if (state.token) await loadSession();
  route();
  if (window.isSecureContext && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
