import { api, state, money, ago } from '../api.js';
import { h, toast, sheet, empty } from '../ui.js';

export async function lobbyView(root, { go }) {
  root.replaceChildren(h('div', { class: 'empty' }, 'Looking for tables…'));
  let rooms = [];
  try { rooms = (await api('/rooms')).rooms; } catch (e) { toast(e.message, 'err'); }

  const wrap = h('div');

  wrap.append(h('div', { class: 'row', style: { marginBottom: '14px', gap: '10px' } },
    h('button', { class: 'btn btn-primary grow', onClick: () => createSheet(go) }, 'Open a table'),
    h('button', { class: 'btn grow', onClick: () => joinSheet(go) }, 'Join with a code')));

  const mine = rooms.filter((r) => r.mine);
  const others = rooms.filter((r) => !r.mine);

  if (!rooms.length) {
    wrap.append(empty('No tables running. Open one and share the code.'));
  }
  if (mine.length) {
    wrap.append(section('Your tables', mine, go));
  }
  if (others.length) {
    wrap.append(section(mine.length ? 'Also running' : 'Running now', others, go));
  }

  root.replaceChildren(wrap);
}

function section(title, rooms, go) {
  return h('div', { class: 'panel' },
    h('h2', {}, title, h('span', { class: 'count' }, rooms.length)),
    h('div', { class: 'stack gap-sm' }, rooms.map((r) => h('button', {
      class: 'seat',
      onClick: () => go(`/room/${r.code}`)
    },
    h('div', { class: 'avatar', style: { background: r.status === 'active' ? 'var(--jade)' : 'var(--slate)' } },
      r.status === 'active' ? '●' : '○'),
    h('div', { class: 'grow' },
      h('div', { class: 'name' }, r.name, r.locked ? h('span', { class: 'tag tag-guest' }, 'locked') : null),
      h('div', { class: 'meta' },
        `${r.code} · ${r.players} ${r.players === 1 ? 'player' : 'players'} · `,
        r.status === 'active' ? `${money(r.pot)} in play` : 'waiting to start',
        ` · ${ago(r.createdAt)}`)),
    h('div', { class: 'result muted' }, '›')))));
}

function createSheet(go) {
  const games = state.boot?.games || {};
  const name = h('input', { type: 'text', placeholder: `${state.me?.displayName}’s table`, maxlength: '40' });
  const game = h('select', {}, Object.entries(games).map(([k, g]) => h('option', { value: k }, g.name)));
  const password = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Optional' });
  const buyIn = h('input', { type: 'number', inputmode: 'decimal', value: String(state.boot?.defaultBuyIn ?? 20), min: '1' });
  const minBuy = h('input', { type: 'number', inputmode: 'decimal', value: '5', min: '0' });
  const step = h('input', { type: 'number', inputmode: 'decimal', value: '5', min: '0' });
  const allowShort = h('input', { type: 'checkbox', checked: true });
  const allowCredit = h('input', { type: 'checkbox', checked: true });
  const selfServe = h('input', { type: 'checkbox', checked: true });

  sheet((close) => [
    h('h2', {}, 'Open a table'),
    h('p', { class: 'sheet-sub' }, 'You can change any of this later, and switch games mid-game.'),
    h('label', { class: 'field' }, h('span', {}, 'Table name'), name),
    h('label', { class: 'field' }, h('span', {}, 'Starting game'), game),
    h('div', { class: 'grid-2' },
      h('label', { class: 'field' }, h('span', {}, 'Standard buy-in'), buyIn),
      h('label', { class: 'field' }, h('span', {}, 'Smallest allowed'), minBuy)),
    h('label', { class: 'field' }, h('span', {}, 'Buy-ins go in steps of'), step),
    h('label', { class: 'switch' }, allowShort,
      h('span', {}, 'Allow buying in short', h('small', {}, 'Anything between the smallest allowed and the standard buy-in goes through without asking.'))),
    h('label', { class: 'switch' }, allowCredit,
      h('span', {}, 'Allow playing on credit', h('small', {}, 'Chips now, cash later. Tracked and settled at the end.'))),
    h('label', { class: 'switch' }, selfServe,
      h('span', {}, 'Players can buy in themselves', h('small', {}, 'Off means every buy-in waits for your approval.'))),
    h('label', { class: 'field' }, h('span', {}, 'Table password'), password),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Cancel'),
      h('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          try {
            const r = await api('/rooms', {
              method: 'POST',
              body: {
                name: name.value,
                password: password.value || null,
                game: game.value,
                config: {
                  defaultBuyIn: Number(buyIn.value),
                  minBuyIn: Number(minBuy.value),
                  buyInIncrement: Number(step.value),
                  allowShortBuy: allowShort.checked,
                  allowCredit: allowCredit.checked,
                  selfServeBuyIn: selfServe.checked
                }
              }
            });
            close();
            go(`/room/${r.room.code}`);
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Open table'))
  ]);
}

function joinSheet(go) {
  const code = h('input', {
    type: 'text', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false',
    maxlength: '5', placeholder: 'ABCDE',
    style: { textTransform: 'uppercase', letterSpacing: '.3em', textAlign: 'center', fontSize: '1.4rem' }
  });
  const password = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Only if the table is locked' });
  const submit = async (close) => {
    try {
      const c = code.value.trim().toUpperCase();
      if (!c) return toast('Enter the five character code.', 'err');
      await api(`/rooms/${c}/join`, { method: 'POST', body: { password: password.value || null } });
      close();
      go(`/room/${c}`);
    } catch (e) { toast(e.message, 'err'); }
  };
  sheet((close) => {
    const box = h('div', {},
      h('h2', {}, 'Join a table'),
      h('p', { class: 'sheet-sub' }, 'Scan the QR on the host’s screen, or type the code.'),
      h('label', { class: 'field' }, h('span', {}, 'Table code'), code),
      h('label', { class: 'field' }, h('span', {}, 'Password'), password),
      h('div', { class: 'sheet-actions' },
        h('button', { class: 'btn', onClick: close }, 'Cancel'),
        h('button', { class: 'btn btn-primary', onClick: () => submit(close) }, 'Sit down')));
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(close); });
    return box;
  });
}
