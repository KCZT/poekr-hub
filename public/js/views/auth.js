import { api, state, setToken } from '../api.js';
import { h, toast, avatar, suitChar } from '../ui.js';

export function authView(root, { onDone }) {
  let mode = state.boot?.needsSetup ? 'signup' : 'login';
  let faces = [];
  let pickedFaces = false;

  api('/auth/faces').then((r) => {
    faces = r.players;
    // Tapping a face is the usual way in once anyone can do it without typing.
    if (faces.length && mode === 'login' && !pickedFaces) { mode = 'pin'; pickedFaces = true; }
    render();
  }).catch(() => {});

  function render() {
    root.replaceChildren(build());
  }

  function build() {
    const wrap = h('div', { style: { maxWidth: '420px', margin: '6vh auto 0' } });

    wrap.append(h('div', { style: { textAlign: 'center', marginBottom: '26px' } },
      h('img', {
        src: '/brand/icon', alt: '', width: '72', height: '72',
        style: { borderRadius: '16px', marginBottom: '10px' }
      }),
      h('div', { style: { fontFamily: 'var(--display)', fontSize: '2.4rem', fontWeight: '900', letterSpacing: '-.02em' } },
        state.boot?.siteName || 'Poker Hub'),
      h('div', { class: 'muted', style: { fontSize: '.9rem' } },
        state.boot?.needsSetup
          ? 'Nobody has signed up yet. The first account runs the place.'
          : 'Buy-ins, cash-outs, and who owes who.')));

    if (mode === 'pin' && faces.length) {
      wrap.append(pinPanel());
      return wrap;
    }

    const username = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', placeholder: 'e.g. riley' });
    const display = h('input', { type: 'text', autocomplete: 'nickname', placeholder: 'Riley' });
    const password = h('input', { type: 'password', autocomplete: mode === 'signup' ? 'new-password' : 'current-password' });

    const submit = async () => {
      try {
        const path = mode === 'signup' ? '/auth/signup' : '/auth/login';
        const body = mode === 'signup'
          ? { username: username.value, displayName: display.value || username.value, password: password.value }
          : { username: username.value, password: password.value };
        const r = await api(path, { method: 'POST', body });
        setToken(r.token);
        state.me = r.player;
        if (r.firstAccount) toast('You are the poker admin. The admin tab is yours.', 'win');
        onDone();
      } catch (err) {
        toast(err.message, 'err');
      }
    };

    const form = h('div', { class: 'panel' },
      h('h2', {}, mode === 'signup' ? 'Create your account' : 'Sign in'),
      h('label', { class: 'field' }, h('span', {}, 'Username'), username),
      mode === 'signup' ? h('label', { class: 'field' }, h('span', {}, 'Name people will see'), display) : null,
      h('label', { class: 'field' },
        h('span', {}, 'Password',
          state.boot?.allowPasswordlessAccounts
            ? h('span', { class: 'hint' }, mode === 'signup'
              ? ' — optional, leave it blank if you like'
              : ' — leave blank if you do not have one')
            : null),
        password),
      mode === 'signup' && state.boot?.allowPasswordlessAccounts
        ? h('p', { class: 'sheet-sub', style: { marginTop: '-4px' } },
          'Without one you sign in by tapping your name. Fine for a game at someone’s house. Add one later from the You tab if you want it.')
        : null,
      h('button', { class: 'btn btn-primary btn-block', onClick: submit },
        mode === 'signup' ? 'Create account' : 'Sign in'),
      h('div', { class: 'row', style: { marginTop: '14px', justifyContent: 'center', flexWrap: 'wrap' } },
        !state.boot?.needsSetup && state.boot?.allowSelfSignup
          ? h('button', {
            class: 'btn btn-ghost btn-sm',
            onClick: () => { mode = mode === 'signup' ? 'login' : 'signup'; render(); }
          }, mode === 'signup' ? 'I already have an account' : 'Create an account')
          : null,
        faces.length
          ? h('button', { class: 'btn btn-ghost btn-sm', onClick: () => { mode = 'pin'; render(); } }, 'Tap a name instead')
          : null));

    form.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    wrap.append(form);
    return wrap;
  }

  /** Shared table device: tap your face, punch a PIN, you are in. */
  function pinPanel() {
    const anyPins = faces.some((f) => f.needsPin);
    const panel = h('div', { class: 'panel' },
      h('h2', {}, 'Who is this?'),
      h('p', { class: 'sheet-sub' },
        anyPins ? 'Tap your face. Some accounts will ask for a PIN.' : 'Tap your face.'));
    const grid = h('div', { class: 'seats' });
    for (const f of faces) {
      grid.append(h('button', {
        class: 'seat',
        onClick: () => (f.needsPin ? askPin(f) : pick(f))
      }, avatar(f), h('div', { class: 'grow' },
        h('div', { class: 'name' }, f.displayName, h('span', { class: 'muted' }, ` ${suitChar(f.suit)}`),
          f.needsPin ? h('span', { class: 'tag tag-guest' }, 'PIN') : null))));
    }
    panel.append(grid, h('div', { class: 'row gap-sm', style: { marginTop: '12px' } },
      h('button', {
        class: 'btn btn-ghost grow',
        onClick: () => { mode = 'login'; render(); }
      }, 'Use a username instead'),
      state.boot?.allowSelfSignup
        ? h('button', {
          class: 'btn btn-ghost grow',
          onClick: () => { mode = 'signup'; render(); }
        }, 'I am new here')
        : null));
    return panel;
  }

  /** No password, no PIN: tapping the face is the whole sign-in. */
  async function pick(face) {
    try {
      const r = await api('/auth/pick', { method: 'POST', body: { playerId: face.id } });
      setToken(r.token);
      state.me = r.player;
      onDone();
    } catch (err) { toast(err.message, 'err'); }
  }

  function askPin(face) {
    const input = h('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off', placeholder: '••••' });
    const go = async () => {
      try {
        const r = await api('/auth/pin', { method: 'POST', body: { playerId: face.id, pin: input.value } });
        setToken(r.token);
        state.me = r.player;
        onDone();
      } catch (err) { toast(err.message, 'err'); input.value = ''; input.focus(); }
    };
    const panel = h('div', { class: 'panel' },
      h('div', { class: 'row', style: { marginBottom: '14px' } }, avatar(face, 'avatar-lg'),
        h('h2', { style: { margin: 0 } }, face.displayName)),
      h('label', { class: 'field' }, h('span', {}, 'PIN'), input),
      h('div', { class: 'sheet-actions' },
        h('button', { class: 'btn', onClick: () => render() }, 'Back'),
        h('button', { class: 'btn btn-primary', onClick: go }, 'Sign in')));
    panel.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    root.replaceChildren(h('div', { style: { maxWidth: '420px', margin: '6vh auto 0' } }, panel));
    input.focus();
  }

  render();
}
