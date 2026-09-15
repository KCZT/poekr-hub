import { api, state, money, signed } from './api.js';
import { h, sheet, avatar, toast, suitChar, share } from './ui.js';

/**
 * Tap any face anywhere in the app and this opens. It is deliberately the only
 * cream object in the interface: it should read as a thing you picked up off
 * the table, not another panel.
 */
export async function openCard(playerId, { onChange } = {}) {
  let data;
  try {
    data = await api(`/players/${playerId}/card`);
  } catch (err) {
    return toast(err.message, 'err');
  }
  const { player, stats, balances, headToHead, between } = data;
  const mine = state.me?.id === player.id;
  const suit = suitChar(player.suit);
  const isRed = player.suit === 'heart' || player.suit === 'diamond';
  const index = stats.sessions ? `${rank(stats)}\n${suit}` : suit;

  sheet((close) => {
    const card = h('div', {
      class: 'pcard',
      'data-index': index,
      style: { '--pc-accent': isRed ? '#b3413c' : '#1a1b17' }
    },
    h('div', { class: 'pcard-head' },
      avatar(player, 'avatar-lg'),
      h('div', { class: 'grow' },
        h('h3', {}, player.displayName),
        h('div', { class: 'handle' }, `@${player.username}`,
          player.role === 'site_admin' ? ' · poker admin' : ''),
        player.bio ? h('p', { class: 'bio' }, player.bio) : null)),

    h('div', { class: 'pcard-net' },
      h('div', { class: 'k' }, stats.sessions ? 'Lifetime' : 'No games yet'),
      h('div', {
        class: 'v num',
        style: { color: stats.net > 0 ? '#3f7a4d' : stats.net < 0 ? '#a9342e' : '#45443b' }
      }, stats.sessions ? signed(stats.net, state.boot?.currency) : '—'),
      stats.adjusted ? h('div', { class: 'k' }, 'Includes a correction by a poker admin') : null),

    stats.history.length > 1 ? sparkline(stats.history) : null,

    h('div', { class: 'pcard-grid' },
      cell('Record', `${stats.wins}–${stats.losses}${stats.evens ? `–${stats.evens}` : ''}`),
      cell('Nights', stats.sessions),
      cell('Win rate', `${stats.winRate}%`),
      cell('Bought in', money(stats.buyIn, state.boot?.currency)),
      cell('Per night', signed(stats.perSession, state.boot?.currency)),
      cell('Return', `${stats.roi > 0 ? '+' : ''}${stats.roi}%`),
      cell('Best night', signed(stats.biggestWin, state.boot?.currency)),
      cell('Worst night', signed(stats.biggestLoss, state.boot?.currency)),
      cell('At the table', `${stats.hours}h`),
      stats.shotsTaken + stats.shotsRefused > 0 ? cell('Took the shot', stats.shotsTaken) : null,
      stats.shotsTaken + stats.shotsRefused > 0 ? cell('Bottled it', stats.shotsRefused) : null),

    headToHead && headToHead.sessions > 0 ? h('div', { class: 'pcard-grid' },
      cell('Nights together', headToHead.sessions),
      cell('You finished ahead', `${headToHead.bBetter}×`),
      cell('They finished ahead', `${headToHead.aBetter}×`)) : null,

    stats.achievements.length ? h('div', { class: 'badges' },
      stats.achievements.map((b) => h('span', { class: 'badge-pill', title: b.hint }, b.name))) : null,

    !mine && between !== undefined && Math.abs(between) >= 0.01
      ? h('div', { class: `pcard-owe ${between < 0 ? 'you-owe' : 'owes-you'}` },
        between < 0
          ? [h('strong', {}, `You owe ${player.displayName} ${money(Math.abs(between), state.boot?.currency)}`),
            payLinks(player, Math.abs(between))]
          : [h('strong', {}, `${player.displayName} owes you ${money(between, state.boot?.currency)}`)])
      : (!mine ? h('div', { class: 'pcard-owe' }, 'You two are square.') : null),

    mine && balances.length ? h('div', { class: 'pcard-owe' },
      h('strong', {}, 'Open with others'),
      h('div', {}, balances.map((b) => h('div', {},
        `${b.amount < 0 ? 'You owe' : 'Owed by'} ${b.otherName}: ${money(Math.abs(b.amount), state.boot?.currency)}`)))) : null);

    const actions = h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onClick: close }, 'Close'),
      mine
        ? h('button', {
          class: 'btn btn-primary',
          onClick: async () => {
            try {
              const r = await api('/players/me/share', { method: 'POST', body: { enabled: !player.hasShare } });
              if (r.shareToken) {
                await share(`${player.displayName} at the poker table`, `${location.origin}/s/player/${r.shareToken}`);
              } else toast('Sharing turned off.');
              onChange?.();
            } catch (e) { toast(e.message, 'err'); }
          }
        }, player.hasShare ? 'Share card' : 'Turn on sharing')
        : (Math.abs(between || 0) >= 0.01
          ? h('button', {
            class: 'btn btn-primary',
            onClick: async () => {
              try {
                const r = await api('/players/me/settle-balance', { method: 'POST', body: { other: player.id } });
                close();
                onChange?.();
                toast('Marked as settled.', 'win', {
                  label: 'Undo',
                  onClick: async () => {
                    try {
                      await api('/players/me/settle-balance/undo', { method: 'POST', body: { undoId: r.undoId } });
                      toast('Put back.', 'win');
                      onChange?.();
                    } catch (e) { toast(e.message, 'err'); }
                  }
                });
              } catch (e) { toast(e.message, 'err'); }
            }
          }, 'Mark settled')
          : null));

    return [card, actions];
  }, { card: true });
}

function cell(k, v) {
  return h('div', {}, h('div', { class: 'k' }, k), h('div', { class: 'v num' }, String(v)));
}

/** A card index that means something: their lifetime standing, not a rank. */
function rank(stats) {
  if (!stats.sessions) return '—';
  if (stats.net > 0) return 'A';
  if (stats.net === 0) return 'J';
  return String(Math.min(9, Math.max(2, Math.ceil(stats.losses / Math.max(1, stats.sessions) * 9))));
}

function sparkline(history) {
  const vals = history.slice(-14);
  let run = 0;
  const cum = vals.map((v) => (run += v.result));
  const max = Math.max(...cum.map(Math.abs), 1);
  return h('div', { class: 'spark', 'aria-hidden': 'true' },
    cum.map((v) => h('i', {
      style: {
        height: `${Math.max(8, (Math.abs(v) / max) * 100)}%`,
        background: v >= 0 ? '#3f7a4d' : '#a9342e'
      }
    })));
}

function payLinks(player, amount) {
  const hs = player.payHandles || {};
  const links = [];
  if (hs.venmo) links.push(['Venmo', `https://venmo.com/${encodeURIComponent(hs.venmo.replace(/^@/, ''))}?txn=pay&amount=${amount}`]);
  if (hs.cashapp) links.push(['Cash App', `https://cash.app/${encodeURIComponent(hs.cashapp.startsWith('$') ? hs.cashapp : `$${hs.cashapp}`)}/${amount}`]);
  if (hs.paypal) links.push(['PayPal', `https://paypal.me/${encodeURIComponent(hs.paypal)}/${amount}`]);
  if (!links.length) return null;
  return h('div', { class: 'chip-row', style: { marginTop: '8px' } },
    links.map(([name, url]) => h('a', {
      class: 'chip', href: url, target: '_blank', rel: 'noopener',
      style: { color: '#45443b', borderColor: 'rgba(0,0,0,.2)' }
    }, `Pay with ${name}`)));
}
