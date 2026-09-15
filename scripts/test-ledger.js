'use strict';
/* Exercises the money model against a night with cash, credit and fronted buy-ins. */
const L = require('../src/ledger');

let fails = 0;
function check(label, actual, expected) {
  const ok = Math.abs(actual - expected) < 0.011;
  if (!ok) fails++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}: ${actual} (expected ${expected})`);
}

function room(entries, config = {}) {
  const players = [...new Set(entries.flatMap((e) => [e.playerId, e.coveredBy, e.counterparty].filter(Boolean)))];
  return {
    id: 'r1',
    config: { currency: '$', defaultBuyIn: 20, minBuyIn: 5, buyInIncrement: 5, allowShortBuy: true, carryDebt: true, ...config },
    players: players.map((id) => ({ playerId: id, status: 'seated' })),
    segments: [{ id: 's1', game: 'texas_holdem' }],
    ledger: entries.map((e, i) => ({ id: `e${i}`, ts: i, voided: false, segmentId: 's1', ...e }))
  };
}


/** Max distance from zero once the suggested payments are made. */
function zeroed(s) {
  const bal = {};
  for (const p of s.payments) {
    bal[p.from] = (bal[p.from] || 0) - p.amount;
    bal[p.to] = (bal[p.to] || 0) + p.amount;
  }
  let worst = 0;
  for (const p of s.positions) {
    worst = Math.max(worst, Math.abs(p.settlementNet - (bal[p.playerId] || 0)));
  }
  return Math.round(worst * 100) / 100;
}

console.log('\n1. Straight cash night — everyone paid up front');
{
  const r = room([
    { type: 'buyin', playerId: 'ana', amount: 20, funding: 'cash' },
    { type: 'buyin', playerId: 'ben', amount: 20, funding: 'cash' },
    { type: 'buyin', playerId: 'cal', amount: 20, funding: 'cash' },
    { type: 'cashout', playerId: 'ana', amount: 45 },
    { type: 'cashout', playerId: 'ben', amount: 15 },
    { type: 'cashout', playerId: 'cal', amount: 0 }
  ]);
  const s = L.settle(r);
  const pos = Object.fromEntries(s.positions.map((p) => [p.playerId, p]));
  check('ana result', pos.ana.result, 25);
  check('cal result', pos.cal.result, -20);
  check('chips reconcile to zero', s.pot.chipsInPlay, 0);
  check('nothing left to pay (box paid out)', s.payments.length, 0);
}

console.log('\n2. Credit buy-in — Cal never put cash in');
{
  const r = room([
    { type: 'buyin', playerId: 'ana', amount: 20, funding: 'cash' },
    { type: 'buyin', playerId: 'cal', amount: 20, funding: 'credit' },
    { type: 'cashout', playerId: 'ana', amount: 40 },
    { type: 'cashout', playerId: 'cal', amount: 0 }
  ]);
  const s = L.settle(r);
  check('one payment needed', s.payments.length, 1);
  console.log(`        ${s.payments[0].from} pays ${s.payments[0].to} $${s.payments[0].amount}`);
  check('cal owes 20', s.payments[0].amount, 20);
  check('payer is cal', s.payments[0].from === 'cal' ? 1 : 0, 1);
  check('payee is ana', s.payments[0].to === 'ana' ? 1 : 0, 1);
}

console.log('\n3. Fronted buy-in — Dev covered Eve, Eve busted');
{
  const r = room([
    { type: 'buyin', playerId: 'dev', amount: 20, funding: 'cash' },
    { type: 'buyin', playerId: 'eve', amount: 20, funding: 'covered', coveredBy: 'dev' },
    { type: 'cashout', playerId: 'dev', amount: 40 },
    { type: 'cashout', playerId: 'eve', amount: 0 }
  ]);
  const s = L.settle(r);
  check('one payment', s.payments.length, 1);
  console.log(`        ${s.payments[0].from} pays ${s.payments[0].to} $${s.payments[0].amount} (${s.payments[0].reason})`);
  check('eve owes dev 20', s.payments[0].amount, 20);
  check('routed back to the person who fronted it', s.payments[0].to === 'dev' ? 1 : 0, 1);
}

console.log('\n4. Messy night — the tangle that should collapse to few payments');
{
  const r = room([
    { type: 'buyin', playerId: 'ana', amount: 20, funding: 'cash' },
    { type: 'buyin', playerId: 'ben', amount: 20, funding: 'credit' },
    { type: 'buyin', playerId: 'cal', amount: 20, funding: 'covered', coveredBy: 'ana' },
    { type: 'buyin', playerId: 'dev', amount: 20, funding: 'credit' },
    { type: 'buyin', playerId: 'ben', amount: 20, funding: 'credit' },
    { type: 'buyin', playerId: 'eve', amount: 15, funding: 'cash', short: true },
    { type: 'cashout', playerId: 'ana', amount: 60 },
    { type: 'cashout', playerId: 'ben', amount: 5 },
    { type: 'cashout', playerId: 'cal', amount: 30 },
    { type: 'cashout', playerId: 'dev', amount: 0 },
    { type: 'cashout', playerId: 'eve', amount: 20 }
  ]);
  const s = L.settle(r);
  const pos = Object.fromEntries(s.positions.map((p) => [p.playerId, p]));
  check('chips reconcile', s.pot.chipsInPlay, 0);
  check('results sum to zero', s.positions.reduce((n, p) => n + p.result, 0), 0);
  check('ben lost 35', pos.ben.result, -35);
  check('ana won 40', pos.ana.result, 40);
  check('eve won 5', pos.eve.result, 5);
  console.log(`        settlement (${s.payments.length} payments):`);
  for (const p of s.payments) console.log(`          ${p.from} -> ${p.to}  $${p.amount}  (${p.reason})`);
  const net = {};
  for (const p of s.payments) {
    net[p.from] = (net[p.from] || 0) - p.amount;
    net[p.to] = (net[p.to] || 0) + p.amount;
  }
  let worst = 0;
  for (const p of s.positions) {
    worst = Math.max(worst, Math.abs(p.settlementNet - (net[p.playerId] || 0)));
  }
  check('everybody ends at zero after the payments', worst, 0);
  check('fewer payments than players', s.payments.length < 5 ? 1 : 0, 1);
}

console.log('\n5. Short buy policy');
{
  const strict = room([], { allowShortBuy: false, defaultBuyIn: 20, minBuyIn: 5 });
  check('short buy blocked for a player', L.checkBuyIn(strict, 10, false).ok ? 1 : 0, 0);
  check('and flagged as needing approval', L.checkBuyIn(strict, 10, false).needsApproval ? 1 : 0, 1);
  check('room admin can push it through', L.checkBuyIn(strict, 10, true).ok ? 1 : 0, 1);
  check('below table minimum always blocked', L.checkBuyIn(strict, 2, true).ok ? 1 : 0, 0);
  check('off-increment blocked', L.checkBuyIn(strict, 12, true).ok ? 1 : 0, 0);
  const loose = room([], { allowShortBuy: true, buyInIncrement: 5 });
  check('short buy allowed when the table permits', L.checkBuyIn(loose, 10, false).ok ? 1 : 0, 1);
  check('and marked short', L.checkBuyIn(loose, 10, false).short ? 1 : 0, 1);
}

console.log('\n6. Voided entries stop counting');
{
  const r = room([
    { type: 'buyin', playerId: 'ana', amount: 20, funding: 'cash' },
    { type: 'buyin', playerId: 'ana', amount: 20, funding: 'cash' },
    { type: 'cashout', playerId: 'ana', amount: 20 }
  ]);
  r.ledger[1].voided = true;
  const s = L.settle(r);
  check('double-entered buy-in removed', s.positions[0].buyIn, 20);
  check('result back to even', s.positions[0].result, 0);
}

console.log('\n7. Carried debt from a previous night folds into tonight');
{
  const r = room([
    { type: 'buyin', playerId: 'ana', amount: 20, funding: 'cash' },
    { type: 'buyin', playerId: 'ben', amount: 20, funding: 'cash' },
    { type: 'cashout', playerId: 'ana', amount: 20 },
    { type: 'cashout', playerId: 'ben', amount: 20 }
  ]);
  const s = L.settle(r, [{ from: 'ben', to: 'ana', amount: 30 }]);
  check('old debt still shows', s.payments.length, 1);
  check('ben still owes 30', s.payments[0]?.amount, 30);
}


console.log('\n8. Pizza — money leaves the group, split evenly');
{
  const r = room([
    { type: 'buyin', playerId: 'ana', amount: 20, funding: 'cash' },
    { type: 'buyin', playerId: 'ben', amount: 20, funding: 'cash' },
    { type: 'buyin', playerId: 'cal', amount: 20, funding: 'cash' },
    // $30 of pizza out of the cash box, split three ways.
    { type: 'expense', playerId: 'ana', amount: 30, label: 'Pizza',
      beneficiary: 'external', fundedFrom: 'box',
      shares: [{ playerId: 'ana', amount: 10 }, { playerId: 'ben', amount: 10 }, { playerId: 'cal', amount: 10 }] },
    { type: 'cashout', playerId: 'ana', amount: 30 },
    { type: 'cashout', playerId: 'ben', amount: 20 },
    { type: 'cashout', playerId: 'cal', amount: 10 }
  ]);
  const s = L.settle(r);
  const pos = Object.fromEntries(s.positions.map((p) => [p.playerId, p]));
  check('chips still reconcile — pizza is cash, not chips', s.pot.chipsInPlay, 0);
  check('poker results are untouched by the pizza', pos.ana.result, 10);
  check('the box is 30 lighter', s.pot.boxCash, -30);
  check('each player carries 10 of it', pos.ben.expenses, 10);
  check('settlement still balances', zeroed(s), 0);
  console.log(`        ${s.payments.length} payment(s): ${s.payments.map((p) => `${p.from}->${p.to} $${p.amount}`).join(', ')}`);
}

console.log('\n9. Someone pays for the pizza out of their own pocket');
{
  const r = room([
    { type: 'buyin', playerId: 'ana', amount: 20, funding: 'cash' },
    { type: 'buyin', playerId: 'ben', amount: 20, funding: 'cash' },
    { type: 'expense', playerId: 'ana', amount: 40, label: 'Pizza',
      beneficiary: 'external', fundedFrom: 'ana',
      shares: [{ playerId: 'ana', amount: 20 }, { playerId: 'ben', amount: 20 }] },
    { type: 'cashout', playerId: 'ana', amount: 20 },
    { type: 'cashout', playerId: 'ben', amount: 20 }
  ]);
  const s = L.settle(r);
  check('one payment', s.payments.length, 1);
  check('ben owes ana his half', s.payments[0]?.amount, 20);
  check('paid to the person who fronted it', s.payments[0]?.to === 'ana' ? 1 : 0, 1);
  check('balances', zeroed(s), 0);
}

console.log('\n10. Host takes a cut, settled at the end');
{
  const r = room([
    { type: 'buyin', playerId: 'ana', amount: 20, funding: 'cash' },
    { type: 'buyin', playerId: 'ben', amount: 20, funding: 'cash' },
    { type: 'buyin', playerId: 'cal', amount: 20, funding: 'cash' },
    { type: 'expense', playerId: 'ana', amount: 15, label: 'Host cut',
      beneficiary: 'ana', fundedFrom: 'later',
      shares: [{ playerId: 'ana', amount: 5 }, { playerId: 'ben', amount: 5 }, { playerId: 'cal', amount: 5 }] },
    { type: 'cashout', playerId: 'ana', amount: 20 },
    { type: 'cashout', playerId: 'ben', amount: 20 },
    { type: 'cashout', playerId: 'cal', amount: 20 }
  ]);
  const s = L.settle(r);
  const pos = Object.fromEntries(s.positions.map((p) => [p.playerId, p]));
  check('host nets the cut minus their own share', pos.ana.settlementNet, 10);
  check('everyone else is down their share', pos.ben.settlementNet, -5);
  check('balances', zeroed(s), 0);
  console.log(`        ${s.payments.map((p) => `${p.from}->${p.to} $${p.amount}`).join(', ')}`);
}

console.log('\n11. Host takes the cut straight out of the box');
{
  // Ben holds the cash so the host's cut and the banker's float stay separate:
  // ana walks away with $10 she only part-funded, so she owes the rest back.
  const r = room([
    { type: 'buyin', playerId: 'ana', amount: 20, funding: 'cash' },
    { type: 'buyin', playerId: 'ben', amount: 20, funding: 'cash' },
    { type: 'expense', playerId: 'ana', amount: 10, label: 'Host cut',
      beneficiary: 'ana', fundedFrom: 'box',
      shares: [{ playerId: 'ana', amount: 5 }, { playerId: 'ben', amount: 5 }] },
    { type: 'cashout', playerId: 'ana', amount: 20 },
    { type: 'cashout', playerId: 'ben', amount: 20 }
  ], { bankerId: 'ben' });
  const s = L.settle(r);
  const pos = Object.fromEntries(s.positions.map((p) => [p.playerId, p]));
  check('host already pocketed the whole cut, so she owes back the half ben funded', pos.ana.settlementNet, -5);
  check('ben is out of pocket for it and gets it back', pos.ben.settlementNet, 5);
  check('the box is 10 lighter', s.pot.boxCash, -10);
  check('balances', zeroed(s), 0);
  console.log(`        ${s.payments.map((p) => `${p.from}->${p.to} $${p.amount}`).join(', ')}`);
}

console.log('\n12. Expenses on an uneven split, excluding someone who left early');
{
  const r = room([
    { type: 'buyin', playerId: 'ana', amount: 20, funding: 'cash' },
    { type: 'buyin', playerId: 'ben', amount: 20, funding: 'cash' },
    { type: 'buyin', playerId: 'cal', amount: 20, funding: 'cash' },
    { type: 'expense', playerId: 'ana', amount: 21, label: 'Beer',
      beneficiary: 'external', fundedFrom: 'box',
      shares: [{ playerId: 'ana', amount: 10.5 }, { playerId: 'ben', amount: 10.5 }] },
    { type: 'cashout', playerId: 'ana', amount: 25 },
    { type: 'cashout', playerId: 'ben', amount: 25 },
    { type: 'cashout', playerId: 'cal', amount: 10 }
  ]);
  const s = L.settle(r);
  const pos = Object.fromEntries(s.positions.map((p) => [p.playerId, p]));
  check('cal pays nothing toward the beer', pos.cal.expenses, 0);
  check('odd cents split cleanly', pos.ana.expenses, 10.5);
  check('balances to the cent', zeroed(s), 0);
}

console.log(`\n${fails === 0 ? 'All checks passed.' : `${fails} check(s) failed.`}\n`);
process.exit(fails === 0 ? 0 : 1);
