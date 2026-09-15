import { api, state, money, signed, ago, clock, readImage } from '../api.js';
import { h, toast, sheet, avatar, confirmSheet, amountField, playSound, playUrl, speak, keepAwake, share, empty, suitChar } from '../ui.js';
import { openCard } from '../card.js';
import * as notify from '../notify.js';

let stream = null;
let ticker = null;

export function leaveRoom() {
  stream?.close();
  stream = null;
  clearInterval(ticker);
  ticker = null;
  keepAwake(false);
  state.room = null;
}

export async function roomView(root, { code, go, setHeader }) {
  root.replaceChildren(h('div', { class: 'empty' }, 'Pulling up the table…'));
  let room;
  try {
    room = (await api(`/rooms/${code}`)).room;
  } catch (e) {
    toast(e.message, 'err');
    return go('/');
  }
  state.room = room;
  state.roomId = room.id;

  const refresh = async () => {
    try {
      state.room = (await api(`/rooms/${state.room.id}`)).room;
      draw();
    } catch (e) { /* transient */ }
  };

  connectStream(room.id, refresh);
  clearInterval(ticker);
  ticker = setInterval(() => {
    const t = root.querySelector('[data-live-clock]');
    if (t && state.room?.startedAt) t.textContent = clock(Date.now() - state.room.startedAt);
  }, 1000);

  let lastRequests = 0;
  function draw() {
    const r = state.room;
    if (!r) return;
    keepAwake(r.status === 'active');

    const waiting = (r.isAdmin ? r.requests.length : 0)
      + r.openPenalties.filter((p) => p.playerId === state.me?.id).length;
    notify.setPending(waiting);
    if (r.isAdmin && r.requests.length > lastRequests) {
      const q = r.requests[r.requests.length - 1];
      const who = r.players.find((p) => p.playerId === q.playerId)?.displayName || 'Someone';
      notify.alert('Buy-in needs approving', {
        body: `${who} wants ${money(q.amount)}${q.short ? ' (short buy)' : ''}.`,
        tag: 'request', urgent: true
      });
    }
    lastRequests = r.isAdmin ? r.requests.length : 0;
    setHeader(r.name, `${r.code} · ${gameName(r.segment?.game)}${r.status === 'ended' ? ' · finished' : ''}`);
    root.replaceChildren(build(r, refresh, go));
  }

  draw();
}

function gameName(g) { return state.boot?.games?.[g]?.name || 'No game'; }

function connectStream(roomId, refresh) {
  stream?.close();
  stream = new EventSource(`/api/rooms/${roomId}/stream`);
  stream.addEventListener('state', refresh);
  stream.addEventListener('feed', refresh);
  stream.addEventListener('photo', refresh);
  stream.addEventListener('ended', refresh);
  stream.addEventListener('sound', (e) => {
    try { playSound(JSON.parse(e.data).event); } catch { /* ignore */ }
  });
  stream.addEventListener('walkup', (e) => {
    try {
      const { playerId } = JSON.parse(e.data);
      const p = state.room?.players.find((x) => x.playerId === playerId);
      const sid = state.players.find((x) => x.id === playerId)?.walkupSoundId;
      const snd = sid && state.sounds.find((s) => s.id === sid);
      if (snd) playUrl(snd.url); else playSound('join');
      if (p) toast(`${p.displayName} sat down.`);
    } catch { /* ignore */ }
  });
  stream.addEventListener('announce', (e) => {
    try {
      const d = JSON.parse(e.data);
      notify.alert(d.by, { body: d.text, tag: 'announce' });
      const snd = d.soundId && state.sounds.find((s) => s.id === d.soundId);
      if (snd) playUrl(snd.url); else playSound('announce');
      toast(`${d.by}: ${d.text}`);
      speak(d.text);
    } catch { /* ignore */ }
  });
  stream.addEventListener('game_change', (e) => {
    try {
      const d = JSON.parse(e.data);
      toast(`Now playing ${d.name}.`, 'win');
      notify.alert('Game switched', { body: `Now playing ${d.name}.`, tag: 'game' });
    } catch { /* ignore */ }
  });
  stream.addEventListener('shot_called', (e) => {
    try {
      const d = JSON.parse(e.data);
      const mine = d.playerId === state.me?.id;
      toast(mine ? `${d.by} called one on you.` : `${d.by} called one on ${d.name}.`, mine ? 'err' : '');
      notify.alert(mine ? 'You owe a shot' : `${d.name} owes a shot`, {
        body: d.reason || (mine ? `${d.by} called it.` : ''),
        tag: 'shot', urgent: mine, force: mine
      });
    } catch { /* ignore */ }
  });
}

// ── Layout ───────────────────────────────────────────────────────────────

function build(r, refresh, go) {
  const me = r.players.find((p) => p.playerId === state.me?.id);
  const wrap = h('div', { class: 'two-col' });
  const left = h('div');
  const right = h('div');

  left.append(readout(r, me));
  if (r.status === 'lobby') left.append(lobbyBanner(r, refresh));
  if (r.isAdmin && r.requests.length) left.append(requestsPanel(r, refresh));
  if (r.config.shotsEnabled) left.append(shotPanel(r, refresh));
  left.append(actionsPanel(r, me, refresh));
  left.append(seatsPanel(r, refresh));
  if (r.status === 'ended' || r.pot.chipsInPlay === 0) left.append(settlementPanel(r, refresh));

  right.append(gamePanel(r, refresh));
  right.append(joinPanel(r));
  right.append(feedPanel(r));
  right.append(ledgerPanel(r, refresh));
  if (r.config.shotsEnabled) right.append(shotBoard(r));
  if (r.photos.length || r.isMember) right.append(photosPanel(r, refresh));
  if (r.isAdmin) right.append(adminPanel(r, refresh, go));

  wrap.append(left, right);
  return wrap;
}

function readout(r, me) {
  return h('div', {},
    h('div', { class: 'readout' },
      h('div', {},
        h('div', { class: 'k' }, 'Chips in play'),
        h('div', { class: 'v num' }, money(r.pot.chipsInPlay))),
      h('div', {},
        h('div', { class: 'k' }, 'Your night'),
        h('div', {
          class: `v num ${me && me.money.result > 0 ? 'up' : me && me.money.result < 0 ? 'down' : ''}`
        }, me ? signed(me.money.result) : '—')),
      h('div', {},
        h('div', { class: 'k' }, r.status === 'active' ? 'Running' : 'Bought in'),
        h('div', { class: 'v num', 'data-live-clock': r.startedAt ? '1' : null },
          r.status === 'active' && r.startedAt ? clock(Date.now() - r.startedAt) : money(r.pot.totalBuyIn)))),
    r.pot.onCredit > 0 || r.pot.spent > 0
      ? h('div', { class: 'panel', style: { padding: '10px 14px', marginTop: '-6px' } },
        r.pot.onCredit > 0
          ? h('div', { class: 'row' },
            h('span', { class: 'tag tag-credit' }, 'credit'),
            h('span', { class: 'muted', style: { fontSize: '.84rem' } },
              `${money(r.pot.onCredit)} of chips is on credit. It gets settled at the end.`))
          : null,
        r.pot.spent > 0
          ? h('div', { class: 'row', style: { marginTop: r.pot.onCredit > 0 ? '6px' : '0' } },
            h('span', { class: 'tag tag-short' }, 'spent'),
            h('span', { class: 'muted', style: { fontSize: '.84rem' } },
              `${money(r.pot.spent)} has left the cash box for other things.`))
          : null)
      : null);
}

function lobbyBanner(r, refresh) {
  return h('div', { class: 'panel' },
    h('div', { class: 'row-between wrap' },
      h('div', {},
        h('strong', {}, 'Waiting to start'),
        h('div', { class: 'muted', style: { fontSize: '.84rem' } },
          'People can sit down and buy in now. The clock starts when you deal.')),
      r.isAdmin
        ? h('button', {
          class: 'btn btn-primary',
          onClick: async () => {
            try { await api(`/rooms/${r.id}/start`, { method: 'POST' }); refresh(); } catch (e) { toast(e.message, 'err'); }
          }
        }, 'Deal the first hand')
        : null));
}

// ── Actions ──────────────────────────────────────────────────────────────

function actionsPanel(r, me, refresh) {
  if (r.status === 'ended') return h('div');
  const row = h('div', { class: 'actions' });

  if (!r.isMember) {
    row.append(h('button', {
      class: 'btn btn-primary',
      onClick: () => joinFlow(r, refresh)
    }, 'Sit down at this table'));
  } else {
    row.append(h('button', { class: 'btn btn-primary', onClick: () => buyInSheet(r, me, refresh) }, 'Buy in'));
    row.append(h('button', { class: 'btn', onClick: () => cashOutSheet(r, me, refresh) }, 'Cash out'));
    row.append(h('button', { class: 'btn', onClick: () => announceSheet(r) }, 'Call out'));
    if (r.config.shotsEnabled) {
      row.append(h('button', { class: 'btn', onClick: () => callShotSheet(r, refresh) }, r.config.shotName));
    }
  }
  if (r.isAdmin) {
    row.append(h('button', { class: 'btn', onClick: () => switchGameSheet(r, refresh) }, 'Switch game'));
    row.append(h('button', { class: 'btn', onClick: () => expenseSheet(r, refresh) }, 'Money out'));
  }
  return h('div', { class: 'panel' }, row);
}

async function joinFlow(r, refresh) {
  const doJoin = async (password) => {
    try {
      await api(`/rooms/${r.id}/join`, { method: 'POST', body: { password } });
      refresh();
    } catch (e) { toast(e.message, 'err'); }
  };
  if (!r.locked) return doJoin(null);
  const pw = h('input', { type: 'password', autocomplete: 'off' });
  sheet((close) => [
    h('h2', {}, 'This table is locked'),
    h('label', { class: 'field' }, h('span', {}, 'Table password'), pw),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Cancel'),
      h('button', { class: 'btn btn-primary', onClick: () => { doJoin(pw.value); close(); } }, 'Sit down'))
  ]);
}

/**
 * Buy-in sheet. The three funding choices are the whole point: paying cash,
 * taking chips on credit, and someone else fronting it are different events and
 * settle differently, so the app asks once instead of guessing.
 */
function buyInSheet(r, me, refresh, targetId) {
  const c = r.config;
  const target = targetId || state.me.id;
  const isSelf = target === state.me.id;
  const presets = [...new Set([c.minBuyIn, c.defaultBuyIn, c.defaultBuyIn * 2, c.defaultBuyIn * 5].filter((n) => n > 0 && n <= c.maxBuyIn))];
  const amount = amountField('Amount', c.defaultBuyIn, presets,
    `standard is ${money(c.defaultBuyIn)}${c.allowShortBuy ? `, short buys down to ${money(c.minBuyIn)} are fine` : ''}`);

  let funding = 'cash';
  let coveredBy = null;

  const note = h('div', { class: 'muted', style: { fontSize: '.8rem', minHeight: '20px' } });
  const others = r.players.filter((p) => p.playerId !== target && p.status !== 'removed');
  const coveredPick = h('select', { class: 'hidden' },
    h('option', { value: '' }, 'Who is fronting it?'),
    others.map((p) => h('option', { value: p.playerId }, p.displayName)));
  coveredPick.addEventListener('change', () => { coveredBy = coveredPick.value || null; });

  const fundBtns = ['cash', 'credit', 'covered']
    .filter((f) => f !== 'credit' || c.allowCredit)
    .map((f) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(f === 'cash'),
      onClick: (e) => {
        funding = f;
        e.currentTarget.parentElement.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', 'false'));
        e.currentTarget.setAttribute('aria-pressed', 'true');
        coveredPick.classList.toggle('hidden', f !== 'covered');
        note.textContent = {
          cash: 'Cash in the box now. Nothing owed.',
          credit: 'Chips now, money later. Shows up in the settle-up at the end.',
          covered: 'Someone else puts the cash in. You pay them back, not the table.'
        }[f];
      }
    }, { cash: 'Paying cash', credit: 'On credit', covered: 'Someone’s covering me' }[f]));

  note.textContent = 'Cash in the box now. Nothing owed.';

  const update = () => {
    const v = Number(amount.input.value);
    warn.textContent = v > 0 && v < c.defaultBuyIn && v >= c.minBuyIn
      ? (c.allowShortBuy ? 'Short buy — allowed at this table.' : 'Short buy — the room admin has to approve this.')
      : '';
  };
  const warn = h('div', { class: 'muted', style: { fontSize: '.8rem', color: 'var(--brass)' } });
  amount.input.addEventListener('input', update);

  sheet((close) => [
    h('h2', {}, isSelf ? 'Buy in' : `Buy in for ${r.players.find((p) => p.playerId === target)?.displayName}`),
    amount, warn,
    h('div', { class: 'field' }, h('span', {}, 'How is it being paid?'),
      h('div', { class: 'chip-row' }, fundBtns), coveredPick, note),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Cancel'),
      h('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          try {
            const res = await api(`/rooms/${r.id}/buyin`, {
              method: 'POST',
              body: { playerId: target, amount: Number(amount.input.value), funding, coveredBy }
            });
            close();
            toast(res.pending ? 'Sent to the room admin for approval.' : 'Chips are yours.', res.pending ? '' : 'win');
            refresh();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Take the chips'))
  ]);
}

function cashOutSheet(r, me, refresh, targetId) {
  const target = targetId || state.me.id;
  const p = r.players.find((x) => x.playerId === target);
  const amount = amountField('Chips counted', '', [0, r.config.defaultBuyIn, r.pot.chipsInPlay].filter((n, i, a) => a.indexOf(n) === i && n >= 0),
    `${money(r.pot.chipsInPlay)} of chips are on the table`);
  const seatOut = h('input', { type: 'checkbox', checked: true });
  const paidNow = h('input', { type: 'checkbox', checked: true });
  const result = h('div', { class: 'bigmoney num muted', style: { textAlign: 'center', margin: '8px 0 4px' } }, '—');
  amount.input.addEventListener('input', () => {
    const v = Number(amount.input.value);
    const net = v - (p?.money.buyIn || 0);
    result.textContent = amount.input.value === '' ? '—' : signed(net);
    result.className = `bigmoney num ${net > 0 ? 'up' : net < 0 ? 'down' : 'muted'}`;
  });

  sheet((close) => [
    h('h2', {}, target === state.me.id ? 'Cash out' : `Cash out ${p?.displayName}`),
    h('p', { class: 'sheet-sub' }, `Bought in for ${money(p?.money.buyIn || 0)}. Count the chips and enter the total.`),
    amount,
    h('div', { class: 'field' }, h('span', {}, 'Result for the night'), result),
    h('label', { class: 'switch' }, paidNow,
      h('span', {}, 'Cash handed over now', h('small', {}, 'Turn this off if there is nothing left in the box to pay them with.'))),
    h('label', { class: 'switch' }, seatOut, h('span', {}, 'Leave the table')),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Cancel'),
      h('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          if (amount.input.value === '') return toast('Enter the chip total, even if it is zero.', 'err');
          try {
            await api(`/rooms/${r.id}/cashout`, {
              method: 'POST',
              body: {
                playerId: target, amount: Number(amount.input.value),
                seatOut: seatOut.checked, paidNow: paidNow.checked
              }
            });
            close();
            refresh();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Cash out'))
  ]);
}

function announceSheet(r) {
  const text = h('input', { type: 'text', maxlength: '140', placeholder: 'Blinds up after this hand' });
  const pick = h('select', {},
    h('option', { value: '' }, 'Default chime'),
    state.sounds.map((s) => h('option', { value: s.id }, s.name)));
  sheet((close) => [
    h('h2', {}, 'Call out to the table'),
    h('p', { class: 'sheet-sub' }, 'Everyone’s phone buzzes and reads it out.'),
    h('label', { class: 'field' }, h('span', {}, 'Message'), text),
    h('label', { class: 'field' }, h('span', {}, 'Sound'), pick),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Cancel'),
      h('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          try {
            await api(`/rooms/${r.id}/announce`, { method: 'POST', body: { text: text.value, soundId: pick.value || null } });
            close();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Say it'))
  ]);
}

// ── Requests ─────────────────────────────────────────────────────────────

function requestsPanel(r, refresh) {
  return h('div', { class: 'panel', style: { borderColor: 'var(--brass)' } },
    h('h2', {}, 'Waiting on you', h('span', { class: 'count' }, r.requests.length)),
    h('div', { class: 'stack gap-sm' }, r.requests.map((q) => {
      const p = r.players.find((x) => x.playerId === q.playerId);
      return h('div', { class: 'seat' },
        avatar(p),
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, p?.displayName || 'Someone',
            q.short ? h('span', { class: 'tag tag-short' }, 'short') : null,
            q.funding === 'credit' ? h('span', { class: 'tag tag-credit' }, 'credit') : null),
          h('div', { class: 'meta' }, `${money(q.amount)}${q.funding === 'covered' ? ` — ${r.players.find((x) => x.playerId === q.coveredBy)?.displayName} fronting` : ''}`)),
        h('div', { class: 'row gap-sm' },
          h('button', {
            class: 'btn btn-sm btn-danger',
            onClick: async () => {
              await api(`/rooms/${r.id}/requests/${q.id}`, { method: 'POST', body: { approve: false } });
              refresh();
            }
          }, 'No'),
          h('button', {
            class: 'btn btn-sm btn-primary',
            onClick: async () => {
              await api(`/rooms/${r.id}/requests/${q.id}`, { method: 'POST', body: { approve: true } });
              refresh();
            }
          }, 'Approve')));
    })));
}

// ── Seats ────────────────────────────────────────────────────────────────

function seatsPanel(r, refresh) {
  const active = r.players.filter((p) => p.status !== 'removed');
  return h('div', { class: 'panel' },
    h('div', { class: 'row-between', style: { marginBottom: '12px' } },
      h('h2', { style: { margin: 0 } }, 'At the table', h('span', { class: 'count' }, active.length)),
      r.isAdmin && r.status !== 'ended'
        ? h('button', { class: 'btn btn-sm', onClick: () => addGuestSheet(r, refresh) }, 'Add guest')
        : null),
    h('div', { class: 'seats' }, active.map((p) => seatRow(r, p, refresh))));
}

function seatRow(r, p, refresh) {
  const net = p.money.result;
  const el = h('button', {
    class: `seat ${p.status === 'out' ? 'is-out' : ''}`,
    onClick: () => (r.isAdmin && r.status !== 'ended' ? playerActions(r, p, refresh) : timelineSheet(r, p))
  },
  avatar(p),
  h('div', { class: 'grow' },
    h('div', { class: 'name' }, p.displayName,
      p.isDealer ? h('span', { class: 'tag tag-owner' }, 'button') : null,
      p.isRoomAdmin ? h('span', { class: 'tag tag-admin' }, 'runs room') : null,
      p.isGuest ? h('span', { class: 'tag tag-guest' }, 'guest') : null,
      p.money.onCredit > 0 ? h('span', { class: 'tag tag-credit' }, 'credit') : null,
      p.money.shortBuys > 0 ? h('span', { class: 'tag tag-short' }, 'short') : null),
    h('div', { class: 'meta' },
      p.status === 'out' ? 'cashed out · ' : '',
      `in ${money(p.money.buyIn)}`,
      p.money.rebuys ? ` · ${p.money.rebuys} rebuy${p.money.rebuys > 1 ? 's' : ''}` : '',
      p.money.cashOut ? ` · out ${money(p.money.cashOut)}` : '',
      p.seatedMs > 60000 ? ` · ${clock(p.seatedMs)}` : '')),
  h('div', { class: `result ${net > 0 ? 'up' : net < 0 ? 'down' : 'muted'}` },
    p.money.buyIn || p.money.cashOut ? signed(net) : '—',
    h('small', {}, suitChar(p.suit))));
  return el;
}

function playerActions(r, p, refresh) {
  sheet((close) => [
    h('div', { class: 'row', style: { marginBottom: '14px' } }, avatar(p, 'avatar-lg'),
      h('div', {}, h('h2', { style: { margin: 0 } }, p.displayName),
        h('div', { class: 'muted', style: { fontSize: '.84rem' } },
          `in ${money(p.money.buyIn)} · out ${money(p.money.cashOut)} · ${signed(p.money.result)}`))),
    h('div', { class: 'stack gap-sm' },
      h('button', { class: 'btn btn-block', onClick: () => { close(); openCard(p.playerId); } }, 'Open their card'),
      h('button', { class: 'btn btn-block', onClick: () => { close(); timelineSheet(r, p); } }, 'Their night, in order'),
      h('button', { class: 'btn btn-block btn-primary', onClick: () => { close(); buyInSheet(r, null, refresh, p.playerId); } }, 'Buy in for them'),
      h('button', { class: 'btn btn-block', onClick: () => { close(); cashOutSheet(r, null, refresh, p.playerId); } }, 'Cash them out'),
      h('button', {
        class: 'btn btn-block',
        onClick: async () => {
          await api(`/rooms/${r.id}/admins`, { method: 'POST', body: { playerId: p.playerId, grant: !p.isRoomAdmin } });
          close(); refresh();
        }
      }, p.isRoomAdmin ? 'Take away room admin' : 'Make them a room admin'),
      h('button', {
        class: 'btn btn-block btn-danger',
        onClick: async () => {
          close();
          if (!await confirmSheet({ title: `Remove ${p.displayName}?`, body: 'Only works once their money is settled.', confirmLabel: 'Remove', danger: true })) return;
          try {
            await api(`/rooms/${r.id}/kick`, { method: 'POST', body: { playerId: p.playerId } });
            refresh();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Remove from table'))
  ]);
}

function addGuestSheet(r, refresh) {
  const name = h('input', { type: 'text', placeholder: 'Name', maxlength: '32' });
  sheet((close) => [
    h('h2', {}, 'Add a guest'),
    h('p', { class: 'sheet-sub' }, 'For someone without an account. Their results still count, and a poker admin can merge them into a real account later.'),
    h('label', { class: 'field' }, h('span', {}, 'Name'), name),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Cancel'),
      h('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          try {
            await api(`/rooms/${r.id}/guests`, { method: 'POST', body: { name: name.value } });
            close(); refresh();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Seat them'))
  ]);
}

// ── Game ─────────────────────────────────────────────────────────────────

function gamePanel(r, refresh) {
  const seg = r.segment;
  const meta = state.boot?.games?.[seg?.game];
  const cfg = seg?.config || {};
  const details = [];
  for (const f of meta?.fields || []) {
    let v = cfg[f.key];
    if (f.type === 'player') v = r.players.find((p) => p.playerId === v)?.displayName || 'nobody yet';
    if (v === '' || v === null || v === undefined) continue;
    if (f.type === 'money' && Number(v) === 0) continue;
    details.push(`${f.label}: ${f.type === 'money' ? money(v) : v}`);
  }

  return h('div', { class: 'panel' },
    h('h2', {}, 'Playing now'),
    h('div', {},
      h('div', { style: { fontFamily: 'var(--display)', fontSize: '1.5rem', fontWeight: '600' } }, gameName(seg?.game)),
      h('div', { class: 'muted', style: { fontSize: '.82rem' } }, meta?.blurb || ''),
      details.length ? h('div', { class: 'muted', style: { fontSize: '.8rem', marginTop: '4px' } }, details.join(' · ')) : null,
      seg?.note ? h('div', { style: { fontSize: '.82rem', color: 'var(--brass)' } }, seg.note) : null),
    r.segments.length > 1
      ? h('div', { style: { marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--felt-line)' } },
        h('div', { class: 'muted', style: { fontSize: '.72rem', marginBottom: '5px' } }, 'Tonight’s run of play'),
        h('div', { class: 'chip-row' }, r.segments.map((s, i) => h('span', {
          class: `chip ${i === r.segments.length - 1 ? 'on' : ''}`
        }, state.boot?.games?.[s.game]?.short || s.game))))
      : null);
}

function switchGameSheet(r, refresh) {
  const games = state.boot?.games || {};
  const pick = h('select', {}, Object.entries(games).map(([k, g]) =>
    h('option', { value: k, selected: k === r.segment?.game }, g.name)));
  const note = h('input', { type: 'text', maxlength: '80', placeholder: 'e.g. intermission before we go back' });
  const fields = h('div');

  const renderFields = () => {
    const meta = games[pick.value];
    fields.replaceChildren(...(meta?.fields || []).map((f) => {
      if (f.type === 'player') {
        const sel = h('select', { dataset: { key: f.key } },
          h('option', { value: '' }, 'Nobody yet'),
          r.players.filter((p) => p.status !== 'removed').map((p) => h('option', { value: p.playerId }, p.displayName)));
        return h('label', { class: 'field' }, h('span', {}, f.label), sel);
      }
      const input = h('input', {
        type: f.type === 'text' ? 'text' : 'number',
        inputmode: f.type === 'text' ? undefined : 'decimal',
        step: 'any',
        value: f.default ?? '',
        dataset: { key: f.key }
      });
      return h('label', { class: 'field' }, h('span', {}, f.label), input);
    }));
  };
  pick.addEventListener('change', renderFields);
  renderFields();

  sheet((close) => [
    h('h2', {}, 'Switch the game'),
    h('p', { class: 'sheet-sub' }, 'Chips and money stay exactly where they are. Results get tracked per game so you can see how you do at each.'),
    h('label', { class: 'field' }, h('span', {}, 'Now playing'), pick),
    fields,
    h('label', { class: 'field' }, h('span', {}, 'Note (optional)'), note),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Cancel'),
      h('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          const config = {};
          fields.querySelectorAll('[data-key]').forEach((el) => {
            config[el.dataset.key] = el.type === 'number' ? Number(el.value) : el.value;
          });
          try {
            await api(`/rooms/${r.id}/segments`, { method: 'POST', body: { game: pick.value, config, note: note.value } });
            close(); refresh();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Switch'))
  ]);
}

// ── Join / QR ────────────────────────────────────────────────────────────

function joinPanel(r) {
  const box = h('div', { class: 'panel' },
    h('h2', {}, 'Get people in'),
    h('div', { class: 'join-row' },
      h('div', {},
        h('div', { class: 'muted', style: { fontSize: '.76rem' } }, 'Table code'),
        h('div', { class: 'code' }, r.code),
        h('div', { class: 'row gap-sm', style: { marginTop: '10px' } },
          h('button', {
            class: 'btn btn-sm',
            onClick: () => share(r.name, `${location.origin}/#/room/${r.code}`, 'Join the table')
          }, 'Share link'),
          r.isAdmin
            ? h('button', {
              class: 'btn btn-sm',
              onClick: async () => {
                try {
                  const s = await api(`/rooms/${r.id}/share`, { method: 'POST', body: { enabled: !r.shareToken } });
                  if (s.shareToken) share('Leaderboard', `${location.origin}/s/room/${s.shareToken}`, 'Live scores');
                  else toast('Public leaderboard turned off.');
                } catch (e) { toast(e.message, 'err'); }
              }
            }, r.shareToken ? 'Share scores' : 'Publish scores')
            : null))));

  const qrSlot = h('div');
  box.querySelector('.join-row').append(qrSlot);
  api(`/rooms/${r.id}/qr`).then(({ dataUrl, secure }) => {
    qrSlot.replaceChildren(h('img', { class: 'qr', src: dataUrl, alt: `QR code to join table ${r.code}` }));
    if (secure) {
      box.append(h('p', { class: 'muted', style: { fontSize: '.78rem', margin: '10px 0 0' } },
        'Phones will warn once that the connection is not private. Tell them to carry on past it — it only means the certificate came from your computer instead of being bought. Alerts and home-screen install need it.'));
    }
  }).catch(() => {});
  return box;
}

// ── Feed, ledger, photos ─────────────────────────────────────────────────

function feedPanel(r) {
  if (!r.feed.length) return h('div');
  return h('div', { class: 'panel' },
    h('h2', {}, 'What happened'),
    h('ul', { class: 'feed' }, r.feed.slice(0, 18).map((f) => h('li', { class: `k-${f.kind}` },
      h('span', { class: 't num' }, ago(f.ts)),
      h('span', { class: 'dot' }),
      h('span', { class: 'grow' }, f.text)))));
}

function ledgerPanel(r, refresh) {
  if (!r.ledger.length) return h('div');
  return h('div', { class: 'panel' },
    h('div', { class: 'row-between', style: { marginBottom: '10px' } },
      h('h2', { style: { margin: 0 } }, 'Every entry', h('span', { class: 'count' }, r.ledger.length)),
      h('a', { class: 'btn btn-sm', href: `/api/rooms/${r.id}/export.csv?token=${state.token}` }, 'Export')),
    h('ul', { class: 'ledger' }, r.ledger.slice(0, 40).map((e) => {
      const p = r.players.find((x) => x.playerId === e.playerId);
      const kind = { buyin: 'bought in', cashout: 'cashed out' }[e.type] || e.type;
      const who = e.type === 'expense'
        ? e.label
        : `${p?.displayName || 'Someone'} ${kind}`;
      return h('li', { class: e.voided ? 'voided' : '' },
        h('div', {},
          h('div', { class: 'who' }, who,
            e.type === 'expense' ? h('span', { class: 'tag tag-short' }, `split ${e.shares?.length || 0}`) : null,
            e.funding === 'credit' ? h('span', { class: 'tag tag-credit' }, ' credit') : null,
            e.short ? h('span', { class: 'tag tag-short' }, ' short') : null),
          h('div', { class: 'when' }, ago(e.ts), e.note ? ` · ${e.note}` : '')),
        h('div', { class: `amt ${e.type === 'cashout' ? 'up' : e.type === 'expense' ? 'down' : ''}` },
          e.type === 'buyin' || e.type === 'expense' ? `−${money(e.amount)}` : money(e.amount)),
        r.isAdmin
          ? h('button', {
            class: 'iconbtn', title: e.voided ? 'Put back' : 'Strike out',
            'aria-label': e.voided ? 'Put entry back' : 'Strike out entry',
            onClick: async (ev) => {
              ev.stopPropagation();
              await api(`/rooms/${r.id}/ledger/${e.id}/void`, { method: 'POST' });
              refresh();
            }
          }, e.voided ? '↺' : '×')
          : h('span'));
    })));
}

function photosPanel(r, refresh) {
  const input = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const dataUrl = await readImage(file, 1400);
      await api(`/rooms/${r.id}/photos`, { method: 'POST', body: { dataUrl } });
      refresh();
    } catch (e) { toast(e.message, 'err'); }
    input.value = '';
  });

  return h('div', { class: 'panel' },
    h('div', { class: 'row-between', style: { marginBottom: '10px' } },
      h('h2', { style: { margin: 0 } }, 'The night', h('span', { class: 'count' }, r.photos.length)),
      r.isMember ? h('button', { class: 'btn btn-sm', onClick: () => input.click() }, 'Add photo') : null),
    input,
    r.photos.length
      ? h('div', { class: 'gallery' }, r.photos.slice(0, 24).map((p) => h('img', {
        src: p.url, alt: p.caption || 'Table photo', loading: 'lazy',
        onClick: () => sheet(() => [
          h('img', { src: p.url, alt: '', style: { width: '100%', borderRadius: 'var(--r-md)' } }),
          p.caption ? h('p', {}, p.caption) : null,
          p.by === state.me?.id || r.isAdmin
            ? h('button', {
              class: 'btn btn-danger btn-block', style: { marginTop: '12px' },
              onClick: async () => {
                await api(`/rooms/${r.id}/photos/${p.id}`, { method: 'DELETE' });
                document.querySelector('.scrim')?.remove();
                refresh();
              }
            }, 'Delete photo')
            : null
        ])
      })))
      : h('p', { class: 'muted', style: { fontSize: '.85rem', margin: 0 } }, 'Nothing yet. Someone take a picture of that river card.'));
}

// ── Settlement ───────────────────────────────────────────────────────────

function settlementPanel(r, refresh) {
  const box = h('div', { class: 'panel', style: { borderColor: 'var(--brass)' } },
    h('h2', {}, 'Settle up'),
    h('div', { class: 'muted' }, 'Working it out…'));

  api(`/rooms/${r.id}/settlement`).then((s) => {
    const kids = [h('h2', {}, 'Settle up')];

    if (Math.abs(s.unreconciled) > 0.009) {
      kids.push(h('p', { class: 'sheet-sub', style: { color: 'var(--brass)' } },
        `${money(s.unreconciled)} in chips is still on the table. Cash everyone out for a final answer.`));
    }

    if (!s.payments.length) {
      kids.push(h('p', { class: 'sheet-sub' }, 'Everyone is square. Nothing to hand over.'));
    } else {
      kids.push(h('p', { class: 'sheet-sub' },
        `${s.payments.length} payment${s.payments.length > 1 ? 's' : ''} clears the whole table.`));
      for (const p of s.payments) {
        const mine = p.from === state.me?.id || p.to === state.me?.id;
        kids.push(h('div', { class: `pay ${mine ? 'mine' : ''}` },
          h('span', {}, s.names[p.from] || 'Someone'),
          h('span', { class: 'arrow' }, '→'),
          h('span', {}, s.names[p.to] || 'Someone'),
          h('span', { class: 'amt num' }, money(p.amount, s.currency))));
        if (p.reason === 'fronted your buy-in') {
          kids.push(h('div', { class: 'muted', style: { fontSize: '.75rem', margin: '-4px 0 8px 13px' } },
            'paying back the buy-in they fronted'));
        }
      }
    }

    if (r.isAdmin && r.status === 'ended') {
      kids.push(h('button', {
        class: 'btn btn-block',
        style: { marginTop: '10px' },
        onClick: () => reopenSheet(r, refresh)
      }, 'Reopen this night'));
    }

    if (r.isAdmin && r.status !== 'ended') {
      kids.push(h('button', {
        class: 'btn btn-primary btn-block',
        style: { marginTop: '10px' },
        onClick: async () => {
          const force = Math.abs(s.unreconciled) > 0.009;
          const ok = await confirmSheet({
            title: 'Close the night?',
            body: force
              ? `${money(s.unreconciled)} in chips is unaccounted for. Closing now records it as is.`
              : 'Results get written to everyone’s lifetime stats and anything unpaid becomes a standing balance.',
            confirmLabel: 'Close the night',
            danger: force
          });
          if (!ok) return;
          try {
            await api(`/rooms/${r.id}/end`, { method: 'POST', body: { force } });
            playSound('settle');
            refresh();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Close the night'));
    }
    box.replaceChildren(...kids.filter(Boolean));
  }).catch(() => box.replaceChildren(h('h2', {}, 'Settle up'), h('p', { class: 'muted' }, 'Could not work out the settlement.')));

  return box;
}

// ── Room admin ───────────────────────────────────────────────────────────

function adminPanel(r, refresh, go) {
  return h('div', { class: 'panel' },
    h('h2', {}, 'Room settings'),
    h('div', { class: 'stack gap-sm' },
      h('button', { class: 'btn btn-block', onClick: () => roomSettingsSheet(r, refresh) }, 'Buy-ins, limits and password'),
      h('button', { class: 'btn btn-block', onClick: () => soundMapSheet(r, refresh) }, 'Table sounds'),
      h('button', { class: 'btn btn-block', onClick: () => seatingSheet(r, refresh) }, 'Seating and the button'),
      h('button', { class: 'btn btn-block btn-ghost muted', onClick: () => go('/') }, 'Back to tables')));
}

function roomSettingsSheet(r, refresh) {
  const c = r.config;
  const name = h('input', { type: 'text', value: r.name, maxlength: '40' });
  const def = h('input', { type: 'number', inputmode: 'decimal', value: String(c.defaultBuyIn) });
  const min = h('input', { type: 'number', inputmode: 'decimal', value: String(c.minBuyIn) });
  const step = h('input', { type: 'number', inputmode: 'decimal', value: String(c.buyInIncrement) });
  const short = h('input', { type: 'checkbox', checked: c.allowShortBuy });
  const credit = h('input', { type: 'checkbox', checked: c.allowCredit });
  const selfServe = h('input', { type: 'checkbox', checked: c.selfServeBuyIn });
  const carry = h('input', { type: 'checkbox', checked: c.carryDebt });
  const banker = h('select', {}, r.players.filter((p) => p.status !== 'removed')
    .map((p) => h('option', { value: p.playerId, selected: p.playerId === c.bankerId }, p.displayName)));
  const pw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Leave blank to keep as is' });
  const shotsOn = h('input', { type: 'checkbox', checked: c.shotsEnabled });
  const shotName = h('input', { type: 'text', value: c.shotName, maxlength: '24' });

  sheet((close) => [
    h('h2', {}, 'Room settings'),
    h('label', { class: 'field' }, h('span', {}, 'Table name'), name),
    h('div', { class: 'grid-2' },
      h('label', { class: 'field' }, h('span', {}, 'Standard buy-in'), def),
      h('label', { class: 'field' }, h('span', {}, 'Smallest allowed'), min)),
    h('label', { class: 'field' }, h('span', {}, 'Buy-ins go in steps of'), step),
    h('label', { class: 'field' },
      h('span', {}, 'Who holds the cash', h('span', { class: 'hint' }, ' — they cover any shortfall in the box')), banker),
    h('label', { class: 'switch' }, short, h('span', {}, 'Allow short buys without asking')),
    h('label', { class: 'switch' }, credit, h('span', {}, 'Allow playing on credit')),
    h('label', { class: 'switch' }, selfServe, h('span', {}, 'Players can buy in themselves')),
    h('label', { class: 'switch' }, carry,
      h('span', {}, 'Carry unpaid amounts forward', h('small', {}, 'Unpaid settlements become standing balances on people’s cards.'))),
    h('label', { class: 'switch' }, shotsOn, h('span', {}, 'Shots are in play')),
    h('label', { class: 'field' }, h('span', {}, 'Call it'), shotName),
    h('label', { class: 'field' }, h('span', {}, 'Change table password'), pw),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Cancel'),
      h('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          try {
            await api(`/rooms/${r.id}`, {
              method: 'PATCH',
              body: {
                name: name.value,
                ...(pw.value ? { password: pw.value } : {}),
                config: {
                  defaultBuyIn: Number(def.value), minBuyIn: Number(min.value),
                  buyInIncrement: Number(step.value), allowShortBuy: short.checked,
                  allowCredit: credit.checked, selfServeBuyIn: selfServe.checked,
                  carryDebt: carry.checked, bankerId: banker.value,
                  shotsEnabled: shotsOn.checked, shotName: shotName.value
                }
              }
            });
            close(); refresh();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Save'))
  ]);
}

function soundMapSheet(r, refresh) {
  if (!state.sounds.length) {
    return sheet((close) => [
      h('h2', {}, 'Table sounds'),
      h('p', { class: 'sheet-sub' }, 'No custom sounds yet. Upload some from the You tab, then map them to what happens at the table.'),
      h('button', { class: 'btn btn-block', onClick: close }, 'Got it')
    ]);
  }
  sheet((close) => [
    h('h2', {}, 'Table sounds'),
    h('p', { class: 'sheet-sub' }, 'Pick what plays on everyone’s phone when something happens.'),
    ...state.soundSlots.map((slot) => {
      const sel = h('select', {},
        h('option', { value: '' }, 'Default chime'),
        state.sounds.map((s) => h('option', { value: s.id, selected: r.sounds[slot.id] === s.id }, s.name)));
      sel.addEventListener('change', async () => {
        try {
          await api(`/rooms/${r.id}/sounds`, { method: 'PUT', body: { event: slot.id, soundId: sel.value || null } });
          const s = state.sounds.find((x) => x.id === sel.value);
          if (s) playUrl(s.url);
          refresh();
        } catch (e) { toast(e.message, 'err'); }
      });
      return h('label', { class: 'field' }, h('span', {}, slot.label), sel);
    }),
    h('button', { class: 'btn btn-block', onClick: close }, 'Done')
  ]);
}


// ── Money that leaves the chips behind ───────────────────────────────────────

function expenseSheet(r, refresh) {
  const seated = r.players.filter((p) => p.status !== 'removed');
  const label = h('input', { type: 'text', maxlength: '40', placeholder: 'Pizza' });
  const amount = amountField('How much', '', [10, 20, 30, 40, 50]);

  const to = h('select', {},
    h('option', { value: 'external' }, 'Someone outside the game'),
    seated.map((p) => h('option', { value: p.playerId }, p.displayName)));

  const from = h('select', {},
    h('option', { value: 'box' }, 'Cash box, now'),
    h('option', { value: 'later' }, 'Nobody yet — settle at the end'),
    seated.map((p) => h('option', { value: p.playerId }, `${p.displayName}, out of pocket`)));

  const boxes = seated.map((p) => {
    const cb = h('input', { type: 'checkbox', checked: true, dataset: { pid: p.playerId } });
    return h('label', { class: 'switch' }, cb, h('span', {}, p.displayName));
  });
  const each = h('div', { class: 'muted', style: { fontSize: '.82rem', minHeight: '20px' } });

  const recount = () => {
    const picked = boxes.filter((b) => b.querySelector('input').checked).length;
    const total = Number(amount.input.value);
    each.textContent = !picked
      ? 'Pick at least one person to split it between.'
      : total > 0
        ? `${money(Math.floor((total / picked) * 100) / 100)} each, ${picked} ${picked === 1 ? 'person' : 'people'}.`
        : `Splitting ${picked} ${picked === 1 ? 'way' : 'ways'}. Put in an amount to see it.`;
  };
  amount.input.addEventListener('input', recount);
  boxes.forEach((b) => b.addEventListener('change', recount));
  recount();

  sheet((close) => [
    h('h2', {}, 'Money out of the pot'),
    h('p', { class: 'sheet-sub' }, 'Pizza, drinks, tips, your cut for hosting. Chips are not touched — this is cash, and it shows up in the settle-up.'),
    h('label', { class: 'field' }, h('span', {}, 'What for'), label),
    amount,
    h('label', { class: 'field' }, h('span', {}, 'Who gets the money'), to),
    h('label', { class: 'field' }, h('span', {}, 'Who is paying it now'), from),
    h('div', { class: 'field' }, h('span', {}, 'Split between'), ...boxes, each),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Cancel'),
      h('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          const among = boxes.filter((b) => b.querySelector('input').checked)
            .map((b) => b.querySelector('input').dataset.pid);
          try {
            await api(`/rooms/${r.id}/expenses`, {
              method: 'POST',
              body: {
                label: label.value, amount: Number(amount.input.value),
                beneficiary: to.value, fundedFrom: from.value, among
              }
            });
            close();
            refresh();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Record it'))
  ]);
}

// ── Seating and the button ───────────────────────────────────────────────────

/**
 * Drag with a finger or a mouse, or use the arrows. The arrows are not a
 * fallback — on a phone they are usually the faster way to do this.
 */
function seatingSheet(r, refresh) {
  let order = r.players.filter((p) => p.status !== 'removed').map((p) => p.playerId);
  const byId = (id) => r.players.find((p) => p.playerId === id);
  const list = h('div', { class: 'stack gap-sm' });

  const move = (from, to) => {
    if (to < 0 || to >= order.length) return;
    const [item] = order.splice(from, 1);
    order.splice(to, 0, item);
    paint();
  };

  function paint() {
    list.replaceChildren(...order.map((pid, i) => {
      const p = byId(pid);
      const row = h('div', {
        class: 'seat', draggable: 'true', dataset: { i: String(i) },
        style: { cursor: 'grab', touchAction: 'none' }
      },
      h('span', { class: 'muted num', style: { width: '18px' } }, String(i + 1)),
      avatar(p, 'avatar-sm'),
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, p.displayName,
          r.dealerId === pid ? h('span', { class: 'tag tag-admin' }, 'button') : null)),
      h('button', {
        class: 'iconbtn', 'aria-label': `Move ${p.displayName} up`,
        disabled: i === 0,
        style: i === 0 ? { opacity: '.3' } : null,
        onClick: (e) => { e.stopPropagation(); move(i, i - 1); }
      }, '↑'),
      h('button', {
        class: 'iconbtn', 'aria-label': `Move ${p.displayName} down`,
        disabled: i === order.length - 1,
        style: i === order.length - 1 ? { opacity: '.3' } : null,
        onClick: (e) => { e.stopPropagation(); move(i, i + 1); }
      }, '↓'));

      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', String(i));
        e.dataTransfer.effectAllowed = 'move';
        row.style.opacity = '.4';
      });
      row.addEventListener('dragend', () => { row.style.opacity = ''; });
      row.addEventListener('dragover', (e) => { e.preventDefault(); });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData('text/plain'));
        if (!Number.isNaN(from)) move(from, i);
      });
      return row;
    }));
  }
  paint();

  sheet((close) => [
    h('h2', {}, 'Seating and the button'),
    h('p', { class: 'sheet-sub' }, 'Drag people around, or use the arrows. The order is who the deal passes to next.'),
    list,
    h('div', { class: 'stack gap-sm', style: { marginTop: '14px' } },
      h('button', {
        class: 'btn btn-block',
        onClick: async () => {
          try {
            await api(`/rooms/${r.id}/dealer`, { method: 'POST' });
            close();
            refresh();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Pass the button to the next seat')),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Cancel'),
      h('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          try {
            await api(`/rooms/${r.id}/seats`, { method: 'POST', body: { order } });
            close();
            refresh();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Save seating'))
  ]);
}

// ── The shot ─────────────────────────────────────────────────────────────────

function callShotSheet(r, refresh) {
  const seated = r.players.filter((p) => p.status !== 'removed');
  const who = h('select', {}, seated.map((p) => h('option', { value: p.playerId }, p.displayName)));
  const reason = h('input', { type: 'text', maxlength: '60', placeholder: 'Optional' });
  sheet((close) => [
    h('h2', {}, `Call a ${r.config.shotName.toLowerCase()}`),
    h('p', { class: 'sheet-sub' }, 'They either take it, or they post a photo with it. Both get counted.'),
    h('label', { class: 'field' }, h('span', {}, 'On who'), who),
    h('label', { class: 'field' }, h('span', {}, 'What did they do'), reason),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Cancel'),
      h('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          try {
            await api(`/rooms/${r.id}/shots`, {
              method: 'POST', body: { playerId: who.value, reason: reason.value }
            });
            close();
            refresh();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Call it'))
  ]);
}

/** The banner the person on the hook sees until they deal with it. */
function shotPanel(r, refresh) {
  const mine = r.openPenalties.filter((p) => p.playerId === state.me?.id);
  const others = r.openPenalties.filter((p) => p.playerId !== state.me?.id);
  if (!mine.length && !others.length) return h('div');

  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'user', class: 'hidden' });
  let answering = null;
  camera.addEventListener('change', async () => {
    const file = camera.files[0];
    if (!file || !answering) return;
    try {
      const dataUrl = await readImage(file, 1400);
      await api(`/rooms/${r.id}/shots/${answering}`, { method: 'POST', body: { took: false, dataUrl } });
      toast('Posted. Everyone can see it.', 'win');
      refresh();
    } catch (e) { toast(e.message, 'err'); }
    camera.value = '';
    answering = null;
  });

  const name = r.config.shotName.toLowerCase();
  const kids = [h('h2', {}, r.config.shotName)];

  for (const p of mine) {
    const by = r.players.find((x) => x.playerId === p.calledBy)?.displayName || 'Someone';
    kids.push(h('div', { class: 'pay mine', style: { flexWrap: 'wrap' } },
      h('div', { class: 'grow' },
        h('strong', {}, `${by} called one on you.`),
        p.reason ? h('div', { class: 'muted', style: { fontSize: '.8rem' } }, p.reason) : null),
      h('div', { class: 'row gap-sm', style: { width: '100%', marginTop: '8px' } },
        h('button', {
          class: 'btn btn-sm btn-primary grow',
          onClick: async () => {
            try {
              await api(`/rooms/${r.id}/shots/${p.id}`, { method: 'POST', body: { took: true } });
              refresh();
            } catch (e) { toast(e.message, 'err'); }
          }
        }, 'I took it'),
        h('button', {
          class: 'btn btn-sm grow',
          onClick: () => { answering = p.id; camera.click(); }
        }, 'Not a chance — photo instead'))));
  }

  for (const p of others) {
    const target = r.players.find((x) => x.playerId === p.playerId)?.displayName || 'Someone';
    kids.push(h('div', { class: 'pay' },
      h('span', { class: 'grow' }, `${target} owes a ${name}.`),
      h('span', { class: 'muted', style: { fontSize: '.78rem' } }, ago(p.ts))));
  }

  kids.push(camera);
  return h('div', { class: 'panel', style: { borderColor: 'var(--clay)' } }, ...kids);
}

/** Running tally, so the argument about who has dodged the most has an answer. */
function shotBoard(r) {
  const rows = r.players
    .filter((p) => p.status !== 'removed' && (p.shots.taken || p.shots.refused))
    .sort((a, b) => (b.shots.taken + b.shots.refused) - (a.shots.taken + a.shots.refused));
  if (!rows.length) return h('div');
  return h('div', { class: 'panel' },
    h('h2', {}, `${r.config.shotName} tally`),
    h('div', { class: 'scroll-x' }, h('table', { class: 'table-list' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Player'),
        h('th', { class: 'n', style: { textAlign: 'right' } }, 'Took it'),
        h('th', { class: 'n', style: { textAlign: 'right' } }, 'Photos'))),
      h('tbody', {}, rows.map((p) => h('tr', { onClick: () => openCard(p.playerId), style: { cursor: 'pointer' } },
        h('td', {}, h('div', { class: 'row gap-sm' }, avatar(p, 'avatar-sm'), h('span', {}, p.displayName))),
        h('td', { class: 'n' }, String(p.shots.taken)),
        h('td', { class: 'n' }, String(p.shots.refused))))))));
}


/** Undoing a close, with the consequences spelled out before it happens. */
function reopenSheet(r, refresh) {
  const reason = h('input', { type: 'text', maxlength: '120', placeholder: 'Dev’s stack was counted short' });
  sheet((close) => [
    h('h2', {}, 'Reopen this night'),
    h('p', { class: 'sheet-sub' },
      'The night goes back to running so you can fix the numbers, then close it again. '
      + 'It comes off everyone’s lifetime stats, and any debts it created get taken back off. '
      + 'If someone has already paid one of those off since, that payment will show as money owed the other way until you close the night again.'),
    h('label', { class: 'field' }, h('span', {}, 'What needs fixing'), reason),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Leave it closed'),
      h('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          try {
            await api(`/rooms/${r.id}/reopen`, { method: 'POST', body: { reason: reason.value } });
            toast('Reopened. Fix it and close the night again.', 'win');
            close();
            refresh();
          } catch (e) { toast(e.message, 'err'); }
        }
      }, 'Reopen'))
  ]);
}

// ── One person's night, in order ─────────────────────────────────────────────

/**
 * Every event that touched this player, with their running position after each
 * one. This is the view you want open when someone says the number is wrong:
 * it answers "how were you down forty at that point" rather than just showing
 * a total.
 */
function timelineSheet(r, p) {
  const cur = r.config.currency;
  const events = [];

  events.push({ ts: p.joinedAt, delta: 0, text: 'Sat down', kind: 'join' });

  for (const e of r.ledger.filter((x) => !x.voided).slice().reverse()) {
    if (e.type === 'buyin' && e.playerId === p.playerId) {
      const how = e.funding === 'credit' ? ' on credit'
        : e.funding === 'covered'
          ? ` — ${r.players.find((x) => x.playerId === e.coveredBy)?.displayName || 'someone'} fronted it` : '';
      events.push({
        ts: e.ts, delta: -e.amount, kind: 'buyin',
        text: `Bought in ${money(e.amount, cur)}${e.short ? ' (short)' : ''}${how}`
      });
    } else if (e.type === 'cashout' && e.playerId === p.playerId) {
      events.push({
        ts: e.ts, delta: e.amount, kind: 'cashout',
        text: `Cashed out ${money(e.amount, cur)}${e.settled === false ? ', not paid yet' : ''}`
      });
    } else if (e.type === 'expense') {
      const share = (e.shares || []).find((sh) => sh.playerId === p.playerId);
      if (share) {
        events.push({ ts: e.ts, delta: -share.amount, kind: 'expense', text: `${e.label} — their share` });
      }
      if (e.beneficiary === p.playerId) {
        events.push({ ts: e.ts, delta: e.amount, kind: 'expense', text: `${e.label} — paid to them` });
      }
    }
  }

  for (const s of r.penalties.filter((x) => x.playerId === p.playerId)) {
    const by = r.players.find((x) => x.playerId === s.calledBy)?.displayName || 'Someone';
    events.push({
      ts: s.ts, delta: 0, kind: 'shot',
      text: s.status === 'taken' ? `Took the ${r.config.shotName.toLowerCase()}`
        : s.status === 'refused' ? 'Refused and posted the photo'
          : `${by} called one on them`
    });
  }

  if (p.leftAt) {
    events.push({ ts: p.leftAt, delta: 0, kind: 'leave', text: p.status === 'out' ? 'Left the table' : 'Stepped away' });
  }

  events.sort((a, b) => a.ts - b.ts);
  let running = 0;

  const rows = events.map((ev) => {
    running = Math.round((running + ev.delta) * 100) / 100;
    const at = new Date(ev.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return h('li', { class: `k-${ev.kind}` },
      h('span', { class: 't num' }, at),
      h('span', { class: 'dot' }),
      h('span', { class: 'grow' }, ev.text),
      ev.delta
        ? h('span', { class: `num ${ev.delta > 0 ? 'up' : 'down'}`, style: { fontSize: '.82rem' } },
          `${ev.delta > 0 ? '+' : ''}${money(ev.delta, cur)}`)
        : null,
      h('span', {
        class: `num ${running > 0 ? 'up' : running < 0 ? 'down' : 'muted'}`,
        style: { fontSize: '.82rem', width: '62px', textAlign: 'right', fontWeight: '600' }
      }, signed(running, cur)));
  });

  sheet((close) => [
    h('div', { class: 'row', style: { marginBottom: '4px' } }, avatar(p, 'avatar-sm'),
      h('h2', { style: { margin: 0 } }, `${p.displayName}’s night`)),
    h('p', { class: 'sheet-sub' },
      `${money(p.money.buyIn, cur)} in, ${money(p.money.cashOut, cur)} out`,
      p.seatedMs > 60000 ? ` · ${clock(p.seatedMs)} at the table` : ''),
    rows.length
      ? h('ul', { class: 'feed' }, rows)
      : h('p', { class: 'muted' }, 'Nothing has happened yet.'),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Close'),
      h('button', { class: 'btn btn-primary', onClick: () => { close(); openCard(p.playerId); } }, 'Open their card'))
  ]);
}
