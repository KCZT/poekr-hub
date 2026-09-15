import { api, state, money, signed } from '../api.js';
import { h, toast, avatar, empty, share, suitChar } from '../ui.js';
import { openCard } from '../card.js';

const WINDOWS = [
  { days: 0, label: 'All time' },
  { days: 365, label: 'Year' },
  { days: 90, label: '90 days' },
  { days: 30, label: '30 days' }
];
const METRICS = [
  { key: 'net', label: 'Net', fmt: (r) => signed(r.net) },
  { key: 'perSession', label: 'Per night', fmt: (r) => signed(r.perSession) },
  { key: 'winRate', label: 'Win rate', fmt: (r) => `${r.winRate}%` },
  { key: 'roi', label: 'Return', fmt: (r) => `${r.roi > 0 ? '+' : ''}${r.roi}%` },
  { key: 'hourly', label: 'Per hour', fmt: (r) => signed(r.hourly) },
  { key: 'sessions', label: 'Nights', fmt: (r) => r.sessions },
  { key: 'best', label: 'Best night', fmt: (r) => signed(r.best) }
];

let days = 0, metric = 'net', game = '';

export async function boardView(root) {
  const wrap = h('div');

  const metricPick = h('select', {}, METRICS.map((m) =>
    h('option', { value: m.key, selected: m.key === metric }, `Rank by ${m.label.toLowerCase()}`)));
  metricPick.addEventListener('change', () => { metric = metricPick.value; boardView(root); });

  const gamePick = h('select', {},
    h('option', { value: '', selected: game === '' }, 'Every game'),
    Object.entries(state.boot?.games || {}).map(([k, g]) =>
      h('option', { value: k, selected: game === k }, g.name)));
  gamePick.addEventListener('change', () => { game = gamePick.value; boardView(root); });

  const controls = h('div', { class: 'panel' },
    h('div', { class: 'chip-row', style: { marginBottom: '10px' } },
      WINDOWS.map((w) => h('button', {
        class: `chip ${w.days === days ? 'on' : ''}`,
        onClick: () => { days = w.days; boardView(root); }
      }, w.label))),
    h('div', { class: 'grid-2' }, metricPick, gamePick));

  wrap.append(controls);
  const body = h('div', { class: 'panel' }, h('div', { class: 'muted' }, 'Adding it up…'));
  wrap.append(body);
  root.replaceChildren(wrap);

  let rows = [];
  try {
    const q = new URLSearchParams({ days: String(days), metric, ...(game ? { game } : {}) });
    rows = (await api(`/players/leaderboard?${q}`)).rows;
  } catch (e) { return toast(e.message, 'err'); }

  if (!rows.length) {
    body.replaceChildren(empty('Nothing here yet. Finish a night and the table fills in.'));
    return;
  }

  const fmt = METRICS.find((m) => m.key === metric).fmt;
  const table = h('table', { class: 'table-list' },
    h('thead', {}, h('tr', {},
      h('th', {}, ''), h('th', {}, 'Player'),
      h('th', { class: 'n', style: { textAlign: 'right' } }, METRICS.find((m) => m.key === metric).label),
      h('th', { class: 'n', style: { textAlign: 'right' } }, 'Nights'),
      metric === 'net' ? null : h('th', { class: 'n', style: { textAlign: 'right' } }, 'Net'))),
    h('tbody', {}, rows.map((r, i) => h('tr', { onClick: () => openCard(r.playerId), style: { cursor: 'pointer' } },
      h('td', { class: `rank ${i === 0 ? 'rank-1' : ''}` }, String(i + 1)),
      h('td', {}, h('div', { class: 'row gap-sm' }, avatar(r, 'avatar-sm'),
        h('span', {}, r.displayName, ' ', h('span', { class: 'muted' }, suitChar(r.suit))))),
      h('td', { class: `n ${(r[metric] || 0) > 0 ? 'up' : (r[metric] || 0) < 0 ? 'down' : ''}` }, fmt(r)),
      h('td', { class: 'n muted' }, String(r.sessions)),
      metric === 'net' ? null
        : h('td', { class: `n ${r.net > 0 ? 'up' : r.net < 0 ? 'down' : ''}` }, signed(r.net))))));

  const actions = state.me?.role === 'site_admin'
    ? h('div', { style: { marginTop: '14px' } },
      h('button', {
        class: 'btn btn-sm',
        onClick: async () => {
          try {
            const r = await api('/admin/leaderboard-share', {
              method: 'POST', body: { enabled: !state.boot.leaderboardToken }
            });
            state.boot.leaderboardToken = r.token;
            if (r.token) share('Poker leaderboard', `${location.origin}/s/leaderboard/${r.token}`, 'Standings');
            else toast('Public leaderboard turned off.');
            boardView(root);
          } catch (e) { toast(e.message, 'err'); }
        }
      }, state.boot?.leaderboardToken ? 'Share the public link' : 'Publish this leaderboard'))
    : null;

  body.replaceChildren(h('div', { class: 'scroll-x' }, table), actions);
  void money;
}
