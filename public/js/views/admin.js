import { api, state, money, signed, ago, readSquareImage } from '../api.js';
import { h, toast, sheet, avatar, confirmSheet, empty } from '../ui.js';
import { openCard } from '../card.js';

/**
 * The webmaster's room. Separate from a room admin on purpose: nothing here
 * touches a live game, and everything here is written to the audit log.
 */
let tab = 'people';

/** Browsers hang on to a favicon hard; re-pointing the link is what shifts it. */
function refreshFavicon() {
  for (const link of document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')) {
    link.href = `/brand/icon?v=${Date.now()}`;
  }
}

export async function adminView(root, { reload }) {
  const wrap = h('div');
  wrap.append(h('div', { class: 'chip-row', style: { marginBottom: '14px' } },
    [['people', 'Accounts'], ['money', 'Who owes who'], ['log', 'Activity log'], ['site', 'Site settings']]
      .map(([k, label]) => h('button', {
        class: `chip ${tab === k ? 'on' : ''}`,
        onClick: () => { tab = k; adminView(root, { reload }); }
      }, label))));

  const body = h('div', {}, h('div', { class: 'empty' }, 'Loading…'));
  wrap.append(body);
  root.replaceChildren(wrap);

  const rerender = () => adminView(root, { reload });

  try {
    if (tab === 'people') body.replaceChildren(await peopleTab(rerender));
    else if (tab === 'money') body.replaceChildren(await moneyTab(rerender));
    else if (tab === 'log') body.replaceChildren(await logTab());
    else body.replaceChildren(await siteTab(rerender));
  } catch (e) {
    body.replaceChildren(empty(e.message));
  }
}

// ── Accounts ─────────────────────────────────────────────────────────────

async function peopleTab(rerender) {
  const { players } = await api('/admin/players');
  const search = h('input', { type: 'search', placeholder: 'Find someone' });
  const list = h('div', { class: 'stack gap-sm' });

  const paint = () => {
    const q = search.value.toLowerCase().trim();
    const shown = players.filter((p) =>
      !q || p.displayName.toLowerCase().includes(q) || p.username.includes(q));
    list.replaceChildren(...shown.map((p) => h('div', {
      class: `seat ${p.disabled ? 'is-out' : ''}`
    },
    avatar(p),
    h('div', { class: 'grow' },
      h('div', { class: 'name' }, p.displayName,
        p.role === 'site_admin' ? h('span', { class: 'tag tag-admin' }, 'poker admin') : null,
        p.isGuest ? h('span', { class: 'tag tag-guest' }, 'guest') : null,
        p.disabled ? h('span', { class: 'tag tag-credit' }, 'switched off') : null,
        !p.hasPassword ? h('span', { class: 'tag tag-guest' }, 'no password') : null,
        p.adjustments ? h('span', { class: 'tag tag-short' }, `${p.adjustments} correction${p.adjustments > 1 ? 's' : ''}`) : null),
      h('div', { class: 'meta' },
        `@${p.username} · ${p.lifetime.sessions} nights · ${signed(p.lifetime.net)}`,
        p.hasPin ? ' · has PIN' : '')),
    h('button', { class: 'btn btn-sm', onClick: () => editPlayer(p, rerender) }, 'Manage'))));
  };
  search.addEventListener('input', paint);
  paint();

  return h('div', {},
    h('div', { class: 'panel' },
      h('div', { class: 'row-between', style: { marginBottom: '12px' } },
        h('h2', { style: { margin: 0 } }, 'Accounts', h('span', { class: 'count' }, players.length)),
        h('button', { class: 'btn btn-sm btn-primary', onClick: () => newPlayer(rerender) }, 'Add account')),
      h('div', { style: { marginBottom: '12px' } }, search),
      list));
}

function newPlayer(rerender) {
  const username = h('input', { type: 'text', autocapitalize: 'none', spellcheck: 'false' });
  const displayName = h('input', { type: 'text' });
  const password = h('input', { type: 'text', placeholder: 'They can change it later' });
  const admin = h('input', { type: 'checkbox' });
  sheet((close) => [
    h('h2', {}, 'Add an account'),
    h('label', { class: 'field' }, h('span', {}, 'Username'), username),
    h('label', { class: 'field' }, h('span', {}, 'Name people see'), displayName),
    h('label', { class: 'field' },
      h('span', {}, 'Starting password', h('span', { class: 'hint' }, ' — optional')), password),
    state.boot?.allowPasswordlessAccounts
      ? h('p', { class: 'sheet-sub', style: { marginTop: '-4px' } },
        'Leave it blank and they sign in by tapping their name.')
      : null,
    h('label', { class: 'switch' }, admin, h('span', {}, 'Make them a poker admin')),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Cancel'),
      h('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          try {
            await api('/admin/players', {
              method: 'POST',
              body: {
                username: username.value, displayName: displayName.value,
                password: password.value, role: admin.checked ? 'site_admin' : 'player'
              }
            });
            close(); rerender();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Create'))
  ]);
}

function editPlayer(p, rerender) {
  sheet((close) => [
    h('div', { class: 'row', style: { marginBottom: '16px' } }, avatar(p, 'avatar-lg'),
      h('div', {}, h('h2', { style: { margin: 0 } }, p.displayName),
        h('div', { class: 'muted', style: { fontSize: '.84rem' } }, `@${p.username}`))),
    h('div', { class: 'stack gap-sm' },
      h('button', { class: 'btn btn-block', onClick: () => { close(); openCard(p.id); } }, 'View their card'),
      h('button', { class: 'btn btn-block', onClick: () => { close(); editDetails(p, rerender); } }, 'Name, username and role'),
      h('button', { class: 'btn btn-block', onClick: () => { close(); editStats(p, rerender); } }, 'Correct their stats'),
      h('button', { class: 'btn btn-block', onClick: () => { close(); resetPassword(p, rerender); } }, 'Password'),
      h('button', { class: 'btn btn-block', onClick: () => { close(); mergeInto(p, rerender); } }, 'Merge into another account'),
      h('button', {
        class: 'btn btn-block btn-danger',
        onClick: async () => {
          close();
          if (!await confirmSheet({
            title: p.disabled ? `Switch ${p.displayName} back on?` : `Switch ${p.displayName} off?`,
            body: p.disabled ? 'They will be able to sign in again.' : 'They cannot sign in, and their history stays intact.',
            confirmLabel: p.disabled ? 'Switch on' : 'Switch off',
            danger: !p.disabled
          })) return;
          try {
            await api(`/admin/players/${p.id}`, { method: 'PATCH', body: { disabled: !p.disabled } });
            rerender();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, p.disabled ? 'Switch account back on' : 'Switch account off'))
  ]);
}

function editDetails(p, rerender) {
  const displayName = h('input', { type: 'text', value: p.displayName });
  const username = h('input', { type: 'text', value: p.username, autocapitalize: 'none', spellcheck: 'false' });
  const role = h('select', {},
    h('option', { value: 'player', selected: p.role !== 'site_admin' }, 'Player'),
    h('option', { value: 'site_admin', selected: p.role === 'site_admin' }, 'Poker admin'));
  sheet((close) => [
    h('h2', {}, 'Account details'),
    h('label', { class: 'field' }, h('span', {}, 'Name people see'), displayName),
    h('label', { class: 'field' }, h('span', {}, 'Username'), username),
    h('label', { class: 'field' },
      h('span', {}, 'Role', h('span', { class: 'hint' }, ' — poker admins run this whole site, not just one room')), role),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Cancel'),
      h('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          try {
            await api(`/admin/players/${p.id}`, {
              method: 'PATCH',
              body: { displayName: displayName.value, username: username.value, role: role.value }
            });
            close(); rerender();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Save'))
  ]);
}

const FIELDS = [
  ['net', 'Lifetime net'], ['sessions', 'Nights played'], ['wins', 'Wins'], ['losses', 'Losses'],
  ['buyIn', 'Total bought in'], ['cashOut', 'Total cashed out'], ['hours', 'Hours played'],
  ['biggestWin', 'Best night'], ['biggestLoss', 'Worst night'], ['rebuys', 'Rebuys'], ['shortBuys', 'Short buys']
];

/** Corrections are deltas with a reason, so nothing is quietly overwritten. */
async function editStats(p, rerender) {
  let data;
  try { data = await api(`/admin/players/${p.id}/stats`); } catch (e) { return toast(e.message, 'err'); }

  const field = h('select', {}, FIELDS.map(([k, label]) =>
    h('option', { value: k }, `${label} — currently ${fmt(k, data.lifetime[k])}`)));
  const target = h('input', { type: 'number', step: 'any', placeholder: 'New value' });
  const reason = h('input', { type: 'text', placeholder: 'e.g. moving over from the old spreadsheet', maxlength: '120' });

  sheet((close) => [
    h('h2', {}, `Correct ${p.displayName}’s stats`),
    h('p', { class: 'sheet-sub' }, 'Set what the number should be. The difference is stored as a correction with your name on it, so the original game history stays untouched and you can undo it.'),
    h('label', { class: 'field' }, h('span', {}, 'Which number'), field),
    h('label', { class: 'field' }, h('span', {}, 'Should be'), target),
    h('label', { class: 'field' }, h('span', {}, 'Why'), reason),
    h('button', {
      class: 'btn btn-primary btn-block',
      onClick: async () => {
        try {
          await api(`/admin/players/${p.id}/stats`, {
            method: 'POST',
            body: { field: field.value, target: Number(target.value), reason: reason.value }
          });
          toast('Correction saved.', 'win');
          close();
          rerender();
        } catch (e) { toast(e.message, 'err'); }
      }
    }, 'Apply correction'),
    data.adjustments.length
      ? h('div', { style: { marginTop: '18px' } },
        h('h2', {}, 'Corrections on file'),
        h('div', { class: 'stack gap-sm' }, data.adjustments.map((a) => h('div', { class: 'seat' },
          h('div', { class: 'grow' },
            h('div', { class: 'name' }, `${FIELDS.find((f) => f[0] === a.field)?.[1] || a.field} ${a.delta > 0 ? '+' : ''}${a.delta}`),
            h('div', { class: 'meta' }, `${a.byName} · ${ago(a.ts)}${a.reason ? ` · ${a.reason}` : ''}`)),
          h('button', {
            class: 'btn btn-sm btn-danger',
            onClick: async () => {
              try {
                await api(`/admin/players/${p.id}/stats/${a.id}`, { method: 'DELETE' });
                close();
                editStats(p, rerender);
              } catch (e) { toast(e.message, 'err'); }
            }
          }, 'Undo'))))) : null
  ]);
}

function fmt(key, v) {
  if (['net', 'buyIn', 'cashOut', 'biggestWin', 'biggestLoss'].includes(key)) return money(v);
  if (key === 'hours') return `${v}h`;
  return String(v);
}

function resetPassword(p, rerender) {
  const password = h('input', { type: 'text', placeholder: 'Leave blank to remove it entirely' });
  const clearPin = h('input', { type: 'checkbox', checked: true });
  const apply = async (close, blank) => {
    try {
      const r = await api(`/admin/players/${p.id}/password`, {
        method: 'POST', body: { password: blank ? '' : password.value, clearPin: clearPin.checked }
      });
      toast(r.hasPassword ? 'Password reset.' : 'Password removed — they tap their name now.', 'win');
      close();
      rerender();
    } catch (e) { toast(e.message, 'err'); }
  };
  sheet((close) => [
    h('h2', {}, `${p.displayName}’s password`),
    h('p', { class: 'sheet-sub' },
      p.hasPassword
        ? 'They get signed out everywhere. Tell them the new one in person, or leave it blank to take the password off.'
        : 'They have no password and sign in by tapping their name. Set one here if they want the account locked down.'),
    h('label', { class: 'field' }, h('span', {}, 'New password'), password),
    h('label', { class: 'switch' }, clearPin, h('span', {}, 'Also clear their PIN')),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Cancel'),
      h('button', { class: 'btn btn-primary', onClick: () => apply(close, false) }, 'Set it')),
    p.hasPassword && state.boot?.allowPasswordlessAccounts
      ? h('button', {
        class: 'btn btn-block btn-danger', style: { marginTop: '10px' },
        onClick: () => apply(close, true)
      }, 'Remove their password')
      : null
  ]);
}

async function mergeInto(p, rerender) {
  const { players } = await api('/admin/players');
  const pick = h('select', {}, players.filter((x) => x.id !== p.id && !x.disabled)
    .map((x) => h('option', { value: x.id }, `${x.displayName} (@${x.username})`)));
  sheet((close) => [
    h('h2', {}, `Merge ${p.displayName}`),
    h('p', { class: 'sheet-sub' }, 'Moves every game, ledger entry and balance onto the other account, then switches this one off. Useful for guests who later sign up, or duplicate accounts.'),
    h('label', { class: 'field' }, h('span', {}, 'Merge into'), pick),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Cancel'),
      h('button', {
        class: 'btn btn-danger',
        onClick: async () => {
          if (!await confirmSheet({ title: 'Merge these accounts?', body: 'This cannot be undone.', confirmLabel: 'Merge', danger: true })) return;
          try {
            await api(`/admin/players/${p.id}/merge`, { method: 'POST', body: { into: pick.value } });
            toast('Merged.', 'win');
            close(); rerender();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Merge'))
  ]);
}

// ── Balances ─────────────────────────────────────────────────────────────

async function moneyTab(rerender) {
  const { balances } = await api('/admin/balances');
  const { sessions } = await api('/admin/sessions');

  return h('div', {},
    h('div', { class: 'panel' },
      h('h2', {}, 'Standing balances', h('span', { class: 'count' }, balances.length)),
      h('p', { class: 'sheet-sub' }, 'Money still owed between people from closed nights.'),
      balances.length
        ? h('div', {}, balances.map((b) => h('div', { class: 'pay' },
          h('span', {}, b.fromName),
          h('span', { class: 'arrow' }, '→'),
          h('span', { class: 'grow' }, b.toName),
          h('span', { class: 'amt num' }, money(b.amount)),
          h('button', {
            class: 'btn btn-sm btn-danger',
            onClick: async () => {
              if (!await confirmSheet({
                title: 'Clear this balance?',
                body: `Wipes the ${money(b.amount)} ${b.fromName} owes ${b.toName}.`,
                confirmLabel: 'Clear it', danger: true
              })) return;
              await api('/admin/balances/clear', { method: 'POST', body: { from: b.from, to: b.to } });
              rerender();
            }
          }, 'Clear'))))
        : h('p', { class: 'muted', style: { margin: 0 } }, 'Nobody owes anybody.')),
    h('div', { class: 'panel' },
      h('h2', {}, 'Past nights', h('span', { class: 'count' }, sessions.length)),
      sessions.length
        ? h('div', { class: 'scroll-x' }, h('table', { class: 'table-list' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Night'), h('th', {}, 'Games'),
            h('th', { class: 'n' }, 'Players'), h('th', { class: 'n' }, 'Volume'), h('th', { class: 'n' }, 'When'))),
          h('tbody', {}, sessions.map((s) => h('tr', {},
            h('td', {}, s.name),
            h('td', { class: 'muted' }, (s.games || []).map((g) => state.boot?.games?.[g]?.short || g).join(', ')),
            h('td', { class: 'n' }, String(s.players)),
            h('td', { class: 'n' }, money(s.volume)),
            h('td', { class: 'n muted' }, ago(s.endedAt)))))))
        : h('p', { class: 'muted', style: { margin: 0 } }, 'No finished nights yet.')));
}

async function logTab() {
  const { audit } = await api('/admin/audit?limit=200');
  return h('div', { class: 'panel' },
    h('h2', {}, 'Activity log'),
    h('p', { class: 'sheet-sub' }, 'Every privileged action, oldest at the bottom.'),
    h('ul', { class: 'feed' }, audit.map((a) => h('li', {},
      h('span', { class: 't num' }, ago(a.ts)),
      h('span', { class: 'dot' }),
      h('span', { class: 'grow' },
        h('strong', {}, a.actorName), ' ', readable(a.action),
        a.detail && Object.keys(a.detail).length
          ? h('div', { class: 'muted', style: { fontSize: '.72rem' } }, summarise(a.detail))
          : null)))));
}

function readable(action) {
  return {
    'account.created': 'created an account',
    'account.created.first': 'set up this site',
    'account.password_changed': 'changed their password',
    'account.password_removed': 'took the password off their account',
    'admin.password_removed': 'removed a password',
    'admin.player_created': 'added an account',
    'admin.player_updated': 'edited an account',
    'admin.password_reset': 'reset a password',
    'admin.stat_adjusted': 'corrected a stat',
    'admin.stat_adjustment_removed': 'undid a stat correction',
    'admin.players_merged': 'merged two accounts',
    'admin.player_deleted': 'deleted an account',
    'admin.settings_updated': 'changed site settings',
    'admin.logo_changed': 'changed the logo',
    'admin.logo_cleared': 'went back to the default logo',
    'admin.balance_cleared': 'cleared a balance',
    'admin.room_deleted': 'deleted a room',
    'admin.leaderboard_share': 'changed leaderboard sharing',
    'room.created': 'opened a table',
    'room.ended': 'closed a night',
    'room.reopened': 'reopened a night',
    'ledger.void': 'struck out a ledger entry',
    'balance.settled': 'settled a balance',
    'balance.settle_undone': 'put a settled balance back'
  }[action] || action;
}

function summarise(d) {
  return Object.entries(d)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `${k}: ${v}`).join(' · ');
}

// ── Site settings ────────────────────────────────────────────────────────

async function siteTab(rerender) {
  const { settings, counts, rooms } = await api('/admin/overview');
  const siteName = h('input', { type: 'text', value: settings.siteName });
  const currency = h('input', { type: 'text', value: settings.currency, maxlength: '3' });
  const defaultBuyIn = h('input', { type: 'number', inputmode: 'decimal', value: String(settings.defaultBuyIn) });
  const minBuyIn = h('input', { type: 'number', inputmode: 'decimal', value: String(settings.minBuyIn) });
  const signup = h('input', { type: 'checkbox', checked: settings.allowSelfSignup });
  const carry = h('input', { type: 'checkbox', checked: settings.carryDebtBetweenSessions });

  const logoInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', class: 'hidden' });
  const logoImg = h('img', {
    src: `/brand/icon?v=${Date.now()}`, alt: '', width: '64', height: '64',
    style: { borderRadius: '14px', background: 'rgba(255,255,255,.05)' }
  });
  logoInput.addEventListener('change', async () => {
    const f = logoInput.files[0];
    if (!f) return;
    try {
      const dataUrl = await readSquareImage(f, 512);
      await api('/admin/brand', { method: 'POST', body: { dataUrl } });
      state.boot = await api('/bootstrap');
      refreshFavicon();
      toast('Logo updated.', 'win');
      rerender();
    } catch (e) { toast(e.message, 'err'); }
    logoInput.value = '';
  });

  return h('div', {},
    h('div', { class: 'readout' },
      h('div', {}, h('div', { class: 'k' }, 'Accounts'), h('div', { class: 'v num' }, String(counts.players))),
      h('div', {}, h('div', { class: 'k' }, 'Nights played'), h('div', { class: 'v num' }, String(counts.sessions))),
      h('div', {}, h('div', { class: 'k' }, 'Open tables'), h('div', { class: 'v num' }, String(counts.openRooms)))),
    h('div', { class: 'panel' },
      h('h2', {}, 'Name and logo'),
      h('p', { class: 'sheet-sub' }, 'What this thing is called and the mark it wears — on the sign-in screen, the browser tab, the home-screen icon and every alert.'),
      h('div', { class: 'row', style: { gap: '14px', marginBottom: '14px' } },
        logoImg,
        h('div', { class: 'grow' },
          h('div', { class: 'row gap-sm wrap' },
            h('button', { class: 'btn btn-sm', onClick: () => logoInput.click() }, 'Upload a logo'),
            state.boot?.hasCustomLogo
              ? h('button', {
                class: 'btn btn-sm btn-ghost muted',
                onClick: async () => {
                  try {
                    await api('/admin/brand', { method: 'DELETE' });
                    state.boot = await api('/bootstrap');
                    refreshFavicon();
                    toast('Back to the default mark.');
                    rerender();
                  } catch (e) { toast(e.message, 'err'); }
                }
              }, 'Use the default')
              : null),
          h('div', { class: 'muted', style: { fontSize: '.76rem', marginTop: '6px' } },
            'A square PNG or SVG works best. Anything else gets fitted into a square. Under 1MB.'))),
      logoInput,
      h('label', { class: 'field' }, h('span', {}, 'Name'), siteName),
      h('div', { class: 'grid-2' },
        h('label', { class: 'field' }, h('span', {}, 'Currency symbol'), currency),
        h('label', { class: 'field' }, h('span', {}, 'Default buy-in'), defaultBuyIn)),
      h('label', { class: 'field' }, h('span', {}, 'Default smallest buy-in'), minBuyIn),
      h('label', { class: 'switch' }, signup,
        h('span', {}, 'Anyone can sign themselves up', h('small', {}, 'Off means only you can create accounts.'))),
      h('label', { class: 'switch' }, carry,
        h('span', {}, 'Carry debts between nights by default')),
      h('button', {
        class: 'btn btn-primary btn-block',
        onClick: async () => {
          try {
            await api('/admin/settings', {
              method: 'PATCH',
              body: {
                siteName: siteName.value, currency: currency.value,
                defaultBuyIn: Number(defaultBuyIn.value), minBuyIn: Number(minBuyIn.value),
                allowSelfSignup: signup.checked, carryDebtBetweenSessions: carry.checked
              }
            });
            state.boot = await api('/bootstrap');
            document.title = state.boot.siteName;
            toast('Settings saved.', 'win');
            rerender();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Save settings')),
    rooms.length
      ? h('div', { class: 'panel' },
        h('h2', {}, 'Open tables', h('span', { class: 'count' }, rooms.length)),
        h('div', { class: 'stack gap-sm' }, rooms.map((r) => h('div', { class: 'seat' },
          h('div', { class: 'grow' },
            h('div', { class: 'name' }, r.name),
            h('div', { class: 'meta' }, `${r.code} · ${r.players} players · ${ago(r.createdAt)}`)),
          h('button', {
            class: 'btn btn-sm btn-danger',
            onClick: async () => {
              if (!await confirmSheet({
                title: `Delete ${r.name}?`,
                body: 'The table and everything in it goes. Finished nights are not affected.',
                confirmLabel: 'Delete', danger: true
              })) return;
              await api(`/admin/rooms/${r.id}`, { method: 'DELETE' });
              rerender();
            }
          }, 'Delete')))))
      : null);
}
