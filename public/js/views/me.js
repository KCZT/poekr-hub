import { api, state, setToken, money, readImage, readFile } from '../api.js';
import { h, toast, sheet, avatar, confirmSheet, playUrl, empty } from '../ui.js';
import { openCard } from '../card.js';
import * as notify from '../notify.js';

export async function meView(root, { go, reload }) {
  const me = state.me;
  const wrap = h('div');

  // ── Identity ───────────────────────────────────────────────────────────
  const avatarInput = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  avatarInput.addEventListener('change', async () => {
    const f = avatarInput.files[0];
    if (!f) return;
    try {
      const dataUrl = await readImage(f, 384);
      const r = await api('/players/me/avatar', { method: 'POST', body: { dataUrl } });
      state.me.avatar = r.avatar;
      toast('Picture updated.', 'win');
      meView(root, { go, reload });
    } catch (e) { toast(e.message, 'err'); }
    avatarInput.value = '';
  });

  wrap.append(h('div', { class: 'panel' },
    h('div', { class: 'row', style: { gap: '14px' } },
      h('button', {
        class: 'iconbtn', style: { width: 'auto', height: 'auto' },
        title: 'Change picture', onClick: () => avatarInput.click()
      }, avatar(me, 'avatar-lg')),
      h('div', { class: 'grow' },
        h('div', { style: { fontFamily: 'var(--display)', fontSize: '1.4rem', fontWeight: '600' } }, me.displayName),
        h('div', { class: 'muted', style: { fontSize: '.84rem' } }, `@${me.username}`,
          me.role === 'site_admin' ? ' · poker admin' : ''),
        h('div', { class: 'row gap-sm', style: { marginTop: '8px' } },
          h('button', { class: 'btn btn-sm', onClick: () => openCard(me.id, { onChange: reload }) }, 'View my card'),
          h('button', { class: 'btn btn-sm', onClick: () => avatarInput.click() }, 'Change picture'),
          me.avatar
            ? h('button', {
              class: 'btn btn-sm btn-ghost muted',
              onClick: async () => {
                await api('/players/me/avatar', { method: 'DELETE' });
                state.me.avatar = null;
                meView(root, { go, reload });
              }
            }, 'Remove')
            : null))),
    avatarInput));

  // ── Details ────────────────────────────────────────────────────────────
  const displayName = h('input', { type: 'text', value: me.displayName, maxlength: '32' });
  const bio = h('input', { type: 'text', value: me.bio || '', maxlength: '140', placeholder: 'Calls too much, folds too little' });
  const accent = h('input', { type: 'color', value: me.accent || '#d2a63c', style: { height: '44px', padding: '4px' } });
  const venmo = h('input', { type: 'text', value: me.payHandles?.venmo || '', placeholder: '@handle' });
  const cashapp = h('input', { type: 'text', value: me.payHandles?.cashapp || '', placeholder: '$cashtag' });
  const paypal = h('input', { type: 'text', value: me.payHandles?.paypal || '', placeholder: 'paypal.me/you' });
  const walkup = h('select', {},
    h('option', { value: '' }, 'None'),
    state.sounds.map((s) => h('option', { value: s.id, selected: me.walkupSoundId === s.id }, s.name)));

  wrap.append(h('div', { class: 'panel' },
    h('h2', {}, 'Your details'),
    h('label', { class: 'field' }, h('span', {}, 'Name people see'), displayName),
    h('label', { class: 'field' }, h('span', {}, 'One line about you'), bio),
    h('label', { class: 'field' }, h('span', {}, 'Card colour'), accent),
    h('label', { class: 'field' },
      h('span', {}, 'Walk-up sound', h('span', { class: 'hint' }, ' — plays when you sit down')), walkup),
    h('h2', { style: { marginTop: '18px' } }, 'How people pay you back'),
    h('p', { class: 'sheet-sub' }, 'These turn into one-tap payment links on your card when someone owes you.'),
    h('div', { class: 'grid-2' },
      h('label', { class: 'field' }, h('span', {}, 'Venmo'), venmo),
      h('label', { class: 'field' }, h('span', {}, 'Cash App'), cashapp)),
    h('label', { class: 'field' }, h('span', {}, 'PayPal'), paypal),
    h('button', {
      class: 'btn btn-primary btn-block',
      onClick: async () => {
        try {
          const r = await api('/players/me', {
            method: 'PATCH',
            body: {
              displayName: displayName.value, bio: bio.value, accent: accent.value,
              walkupSoundId: walkup.value || null,
              payHandles: { venmo: venmo.value, cashapp: cashapp.value, paypal: paypal.value }
            }
          });
          state.me = r.player;
          toast('Saved.', 'win');
        } catch (e) { toast(e.message, 'err'); }
      }
    }, 'Save details')));

  // ── Money owed ─────────────────────────────────────────────────────────
  const balancePanel = h('div', { class: 'panel' }, h('h2', {}, 'Open money'), h('div', { class: 'muted' }, 'Checking…'));
  wrap.append(balancePanel);
  api(`/players/${me.id}/card`).then(({ balances }) => {
    const kids = [h('h2', {}, 'Open money', h('span', { class: 'count' }, balances.length))];
    if (!balances.length) {
      kids.push(h('p', { class: 'sheet-sub', style: { margin: 0 } }, 'You are square with everyone.'));
    } else {
      for (const b of balances) {
        kids.push(h('div', { class: 'pay' },
          h('span', {}, b.amount < 0 ? 'You owe' : 'Owed by'),
          h('span', { class: 'grow' }, b.otherName),
          h('span', { class: `amt num ${b.amount < 0 ? 'down' : 'up'}` }, money(Math.abs(b.amount))),
          h('button', {
            class: 'btn btn-sm',
            onClick: async () => {
              if (!await confirmSheet({
                title: 'Mark as settled?',
                body: `This clears the ${money(Math.abs(b.amount))} between you and ${b.otherName}.`,
                confirmLabel: 'Mark settled'
              })) return;
              try {
                const r = await api('/players/me/settle-balance', { method: 'POST', body: { other: b.other } });
                meView(root, { go, reload });
                toast('Cleared.', 'win', {
                  label: 'Undo',
                  onClick: async () => {
                    try {
                      await api('/players/me/settle-balance/undo', { method: 'POST', body: { undoId: r.undoId } });
                      toast('Put back.', 'win');
                      meView(root, { go, reload });
                    } catch (e) { toast(e.message, 'err'); }
                  }
                });
              } catch (e) { toast(e.message, 'err'); }
            }
          }, 'Settle')));
      }
    }
    balancePanel.replaceChildren(...kids);
  }).catch(() => balancePanel.replaceChildren(h('h2', {}, 'Open money'), h('p', { class: 'muted' }, 'Could not load.')));

  // ── Alerts ─────────────────────────────────────────────────────────────
  const alertState = notify.status();
  wrap.append(h('div', { class: 'panel' },
    h('h2', {}, 'Alerts'),
    h('p', { class: 'sheet-sub' },
      alertState === 'granted'
        ? 'Your phone buzzes when a shot is called on you, someone calls out, or a buy-in needs your approval. Works while the app is open in the background.'
        : alertState === 'insecure'
          ? 'You opened this over a plain link, and browsers switch alerts off there. Open the secure link below instead and they will work. It is the same app on the same computer.'
          : alertState === 'denied'
            ? 'Your browser is blocking alerts for this site. Turn them back on in its site settings if you want them.'
            : 'Get a buzz when a shot is called on you, someone calls out, or a buy-in needs approving. No internet needed — it comes straight off the table.'),
    alertState === 'insecure' && state.boot?.secureUrl
      ? h('div', {},
        h('a', { class: 'btn btn-primary btn-block', href: state.boot.secureUrl }, 'Open the secure link'),
        h('p', { class: 'sheet-sub', style: { marginTop: '10px', marginBottom: 0 } },
          'Your browser will warn you once that the connection is not private. That is expected — the certificate is made by the computer running this, not bought from anyone. Carry on past it and you will not be asked again.'))
      : null,
    alertState === 'default'
      ? h('button', {
        class: 'btn btn-primary btn-block',
        onClick: async () => {
          const result = await notify.ask();
          toast(result === 'granted' ? 'Alerts on.' : 'Alerts stayed off.', result === 'granted' ? 'win' : '');
          meView(root, { go, reload });
        }
      }, 'Turn on alerts')
      : alertState === 'granted'
        ? h('button', {
          class: 'btn btn-block',
          onClick: () => notify.alert(state.boot?.siteName || 'Poker Hub',
          { body: 'That is what they look like.', force: true, tag: 'test' })
        }, 'Send me a test one')
        : null));

  if (me.role === 'site_admin') {
    wrap.append(h('div', { class: 'panel' },
      h('h2', {}, 'Back it all up'),
      h('p', { class: 'sheet-sub' }, 'One file with every account, night, ledger entry and photo in it. Keep a copy somewhere that is not this laptop.'),
      h('a', {
        class: 'btn btn-block',
        href: `/api/admin/backup.zip?token=${state.token}`,
        download: ''
      }, 'Download a backup')));
  }

  // ── Sounds ─────────────────────────────────────────────────────────────
  wrap.append(soundsPanel(() => meView(root, { go, reload })));

  // ── Security ───────────────────────────────────────────────────────────
  wrap.append(h('div', { class: 'panel' },
    h('h2', {}, 'Password and PIN'),
    h('p', { class: 'sheet-sub' },
      me.hasPassword
        ? 'You sign in with a username and password.'
        : state.boot?.allowPasswordlessAccounts
          ? 'You have no password, so you sign in by tapping your name on the sign-in screen. That is fine for a game at someone’s house — add one if you want the account locked down.'
          : 'You have no password, and this install is on a public address where one is needed. Set one now or you will not be able to sign in again.'),
    !me.hasPassword && me.role === 'site_admin'
      ? h('p', { class: 'sheet-sub', style: { color: 'var(--brass)' } },
        'You are the poker admin. Without a password, anyone who can reach this app can sign in as you and manage every account.')
      : null,
    h('div', { class: 'stack gap-sm' },
      h('button', {
        class: `btn btn-block ${!me.hasPassword && me.role === 'site_admin' ? 'btn-primary' : ''}`,
        onClick: () => passwordSheet(me, () => meView(root, { go, reload }))
      }, me.hasPassword ? 'Change or remove your password' : 'Set a password'),
      h('button', {
        class: 'btn btn-block',
        onClick: () => pinSheet(() => meView(root, { go, reload }))
      }, me.hasPin ? 'Change or remove your PIN' : 'Set a PIN for shared devices'),
      h('button', {
        class: 'btn btn-block btn-danger',
        onClick: async () => {
          if (!await confirmSheet({ title: 'Sign out?', confirmLabel: 'Sign out', danger: true })) return;
          try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
          setToken(null);
          state.me = null;
          go('/');
          location.reload();
        }
      }, 'Sign out'))));

  root.replaceChildren(wrap);
}

function soundsPanel(refresh) {
  const input = h('input', { type: 'file', accept: 'audio/*', class: 'hidden' });
  const nameInput = h('input', { type: 'text', placeholder: 'Name it', maxlength: '40' });

  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    try {
      const dataUrl = await readFile(f, 3e6);
      const name = nameInput.value.trim() || f.name.replace(/\.[^.]+$/, '').slice(0, 40);
      const r = await api('/sounds', { method: 'POST', body: { name, dataUrl } });
      state.sounds.push(r.sound);
      nameInput.value = '';
      toast('Sound added.', 'win');
      refresh();
    } catch (e) { toast(e.message, 'err'); }
    input.value = '';
  });

  return h('div', { class: 'panel' },
    h('h2', {}, 'Sound library', h('span', { class: 'count' }, state.sounds.length)),
    h('p', { class: 'sheet-sub' }, 'Upload clips once, then a room admin maps them to buy-ins, blinds going up, whatever. Under 3MB, mp3 or wav.'),
    h('div', { class: 'row gap-sm', style: { marginBottom: '12px' } },
      nameInput, input,
      h('button', { class: 'btn', style: { flex: 'none' }, onClick: () => input.click() }, 'Upload')),
    state.sounds.length
      ? h('div', { class: 'stack gap-sm' }, state.sounds.map((s) => h('div', { class: 'seat' },
        h('button', { class: 'iconbtn', title: 'Play', onClick: () => playUrl(s.url) }, '▶'),
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, s.name),
          h('div', { class: 'meta' }, `${s.byName || 'someone'} · ${Math.round(s.bytes / 1024)}KB`)),
        s.by === state.me?.id || state.me?.role === 'site_admin'
          ? h('button', {
            class: 'iconbtn', title: 'Delete',
            onClick: async () => {
              try {
                await api(`/sounds/${s.id}`, { method: 'DELETE' });
                state.sounds = state.sounds.filter((x) => x.id !== s.id);
                refresh();
              } catch (e) { toast(e.message, 'err'); }
            }
          }, '×')
          : null)))
      : empty('No custom sounds yet.'));
}

function passwordSheet(me, refresh) {
  const current = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password' });

  const save = async (close, remove) => {
    try {
      const r = await api('/auth/password', {
        method: 'POST',
        body: { current: current.value, next: remove ? '' : next.value }
      });
      state.me.hasPassword = r.hasPassword;
      toast(r.hasPassword ? 'Password set.' : 'Password removed. Tap your name to sign in from now on.', 'win');
      close();
      refresh();
    } catch (e) { toast(e.message, 'err'); }
  };

  sheet((close) => [
    h('h2', {}, me.hasPassword ? 'Change or remove your password' : 'Set a password'),
    me.hasPassword
      ? h('label', { class: 'field' }, h('span', {}, 'Current password'), current)
      : h('p', { class: 'sheet-sub' }, 'You do not have one yet, so there is nothing to confirm.'),
    h('label', { class: 'field' },
      h('span', {}, me.hasPassword ? 'New password' : 'Password',
        h('span', { class: 'hint' }, ' — at least 6 characters')),
      next),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Cancel'),
      h('button', { class: 'btn btn-primary', onClick: () => save(close, false) },
        me.hasPassword ? 'Change it' : 'Set it')),
    me.hasPassword && state.boot?.allowPasswordlessAccounts
      ? h('button', {
        class: 'btn btn-block btn-danger',
        style: { marginTop: '10px' },
        onClick: async () => {
          if (!await confirmSheet({
            title: 'Take the password off?',
            body: 'You will sign in by tapping your name instead. Anyone who can reach this app will be able to do the same.',
            confirmLabel: 'Remove it',
            danger: true
          })) return;
          save(close, true);
        }
      }, 'Remove my password')
      : null
  ]);
}

function pinSheet(refresh) {
  const pin = h('input', { type: 'password', inputmode: 'numeric', placeholder: '4 to 8 digits' });
  const password = h('input', { type: 'password', autocomplete: 'current-password' });
  sheet((close) => [
    h('h2', {}, 'PIN for shared devices'),
    h('p', { class: 'sheet-sub' }, 'Lets you tap your face and punch a short code on the host’s laptop instead of typing your password. Your account still needs the full password everywhere else.'),
    h('label', { class: 'field' }, h('span', {}, 'New PIN', h('span', { class: 'hint' }, ' — leave blank to remove')), pin),
    state.me?.hasPassword
      ? h('label', { class: 'field' }, h('span', {}, 'Confirm with your password'), password)
      : null,
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Cancel'),
      h('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          try {
            const r = await api('/auth/set-pin', { method: 'POST', body: { pin: pin.value || null, password: password.value } });
            state.me.hasPin = r.hasPin;
            toast(r.hasPin ? 'PIN set.' : 'PIN removed.', 'win');
            close();
            refresh();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Save PIN'))
  ]);
}
