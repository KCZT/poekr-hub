'use strict';
/**
 * The money model.
 *
 * Every entry is a fact about cash or chips, never an opinion. From those facts
 * we derive two different numbers people care about, which the old app confused:
 *
 *   result    = chips cashed out - chips bought        ("did I win tonight?")
 *   remaining = result + cash already moved            ("do I still owe anyone?")
 *
 * `remaining` sums to zero across the table, so it can be collapsed into the
 * smallest possible set of payments instead of a tangle of IOUs.
 */

const round = (n) => Math.round(n * 100) / 100;

/** Entries that still count. Voided entries stay in history but stop counting. */
function live(room) {
  return (room.ledger || []).filter((e) => !e.voided);
}

/**
 * Per-player derived money. Returns a map keyed by playerId.
 *  buyIn     total chips taken
 *  cashOut   total chips turned back in
 *  result    cashOut - buyIn
 *  paid      real cash this person has handed over (incl. fronting others)
 *  received  real cash handed to this person
 *  remaining what's still outstanding: <0 must pay, >0 must be paid
 *  onCredit  chips taken without paying, still unpaid
 */
function positions(room) {
  const map = new Map();
  const seat = (pid) => {
    if (!map.has(pid)) {
      map.set(pid, {
        playerId: pid, buyIn: 0, cashOut: 0, result: 0,
        paid: 0, received: 0, onCredit: 0, remaining: 0, expenses: 0,
        shortBuys: 0, rebuys: 0, fronted: 0, frontedBy: {}
      });
    }
    return map.get(pid);
  };
  for (const p of room.players || []) seat(p.playerId);

  for (const e of live(room)) {
    if (e.type === 'buyin') {
      const s = seat(e.playerId);
      s.buyIn += e.amount;
      if (s.buyIn > e.amount) s.rebuys += 1;
      if (e.short) s.shortBuys += 1;
      if (e.funding === 'cash') {
        s.paid += e.amount;
      } else if (e.funding === 'credit') {
        s.onCredit += e.amount;
      } else if (e.funding === 'covered' && e.coveredBy) {
        const f = seat(e.coveredBy);
        f.paid += e.amount;
        f.fronted += e.amount;
        s.frontedBy[e.coveredBy] = round((s.frontedBy[e.coveredBy] || 0) + e.amount);
      }
    } else if (e.type === 'cashout') {
      const s = seat(e.playerId);
      s.cashOut += e.amount;
      if (e.settled !== false) s.received += e.amount;
    } else if (e.type === 'expense') {
      /**
       * Money that leaves the chips behind — pizza, tips, the host's cut.
       * Three separate facts, kept apart so the columns still balance:
       * who bears the cost (shares), who ends up with the money (beneficiary),
       * and whose cash actually moved tonight (fundedFrom).
       */
      for (const share of e.shares || []) seat(share.playerId).expenses += share.amount;
      if (e.beneficiary && e.beneficiary !== 'external') seat(e.beneficiary).paid += e.amount;
      if (e.fundedFrom && e.fundedFrom !== 'box' && e.fundedFrom !== 'later') {
        seat(e.fundedFrom).paid += e.amount;
      }
      if (e.fundedFrom === 'box' && e.beneficiary && e.beneficiary !== 'external') {
        seat(e.beneficiary).received += e.amount;
      }
    }
  }

  for (const s of map.values()) {
    s.buyIn = round(s.buyIn);
    s.cashOut = round(s.cashOut);
    s.paid = round(s.paid);
    s.received = round(s.received);
    s.expenses = round(s.expenses);
    s.result = round(s.result + (s.cashOut - s.buyIn));
    s.remaining = round(s.remaining + s.result + s.paid - s.received - s.expenses);
  }
  return map;
}

/** Chips on the table right now, and whether the cash box balances. */
function potState(room) {
  let bought = 0, out = 0, cashIn = 0, cashOut = 0, credit = 0, spent = 0;
  for (const e of live(room)) {
    if (e.type === 'expense' && e.fundedFrom === 'box') spent += e.amount;
    if (e.type === 'buyin') {
      bought += e.amount;
      if (e.funding === 'credit') credit += e.amount; else cashIn += e.amount;
    } else if (e.type === 'cashout') {
      out += e.amount;
      if (e.settled !== false) cashOut += e.amount;
    }
  }
  return {
    chipsInPlay: round(bought - out),
    totalBuyIn: round(bought),
    totalCashOut: round(out),
    boxCash: round(cashIn - cashOut - spent),
    onCredit: round(credit),
    spent: round(spent)
  };
}

/**
 * Collapse everyone's `remaining` into the fewest payments.
 * Two passes: first honour direct obligations (if Dev fronted Sam's buy-in,
 * Sam should pay Dev back rather than some stranger), then greedily match the
 * biggest remaining debtor to the biggest remaining creditor.
 */
const BOX = '__box';

function settle(room, carried = []) {
  const pos = positions(room);
  const net = new Map();
  for (const s of pos.values()) net.set(s.playerId, s.remaining);

  /**
   * The pile of cash is a party too. If more went out of it than came in,
   * whoever holds it covered the difference out of pocket and is owed it back.
   * Folding that into the banker's line is what makes every column sum to zero
   * — without it, credit buy-ins leave money that belongs to nobody.
   */
  const box = potState(room);
  const bankerId = room.config?.bankerId
    && pos.has(room.config.bankerId) ? room.config.bankerId
    : (room.players || []).find((p) => p.status !== 'removed')?.playerId || BOX;
  if (Math.abs(box.boxCash) > 0.009) {
    net.set(bankerId, round((net.get(bankerId) || 0) - box.boxCash));
  }

  // Fold in balances carried over from previous nights.
  for (const b of carried) {
    if (!net.has(b.from) && !net.has(b.to)) continue;
    net.set(b.from, round((net.get(b.from) || 0) - b.amount));
    net.set(b.to, round((net.get(b.to) || 0) + b.amount));
  }

  const net0 = new Map(net); // snapshot before the passes below drain it

  const payments = [];
  const take = (from, to, amount, reason) => {
    if (amount < 0.01) return;
    payments.push({ from, to, amount: round(amount), reason });
    net.set(from, round(net.get(from) + amount));
    net.set(to, round(net.get(to) - amount));
  };

  // Pass 1 — direct obligations from fronted buy-ins.
  for (const s of pos.values()) {
    for (const [fronter, amount] of Object.entries(s.frontedBy)) {
      const debt = -(net.get(s.playerId) || 0);
      const credit = net.get(fronter) || 0;
      const pay = Math.min(amount, debt, credit);
      if (pay > 0.009) take(s.playerId, fronter, pay, 'fronted your buy-in');
    }
  }

  // Pass 2 — greedy min cash flow on whatever is left.
  const debtors = [...net.entries()].filter(([, v]) => v < -0.009)
    .map(([id, v]) => ({ id, v: -v })).sort((a, b) => b.v - a.v);
  const creditors = [...net.entries()].filter(([, v]) => v > 0.009)
    .map(([id, v]) => ({ id, v })).sort((a, b) => b.v - a.v);

  let i = 0, j = 0;
  let guard = 0;
  while (i < debtors.length && j < creditors.length && guard++ < 500) {
    const pay = Math.min(debtors[i].v, creditors[j].v);
    if (pay > 0.009) {
      payments.push({ from: debtors[i].id, to: creditors[j].id, amount: round(pay), reason: 'settle up' });
    }
    debtors[i].v = round(debtors[i].v - pay);
    creditors[j].v = round(creditors[j].v - pay);
    if (debtors[i].v < 0.01) i++;
    if (creditors[j].v < 0.01) j++;
  }

  // Merge duplicate pairs so nobody gets two "pay Ellie" lines.
  const merged = new Map();
  for (const p of payments) {
    const key = `${p.from}>${p.to}`;
    if (merged.has(key)) {
      const m = merged.get(key);
      m.amount = round(m.amount + p.amount);
    } else merged.set(key, { ...p });
  }

  return {
    payments: [...merged.values()].sort((a, b) => b.amount - a.amount),
    // settlementNet: >0 they should be handed money, <0 they should hand it over.
    positions: [...pos.values()].map((p) => ({
      ...p,
      settlementNet: round(net0.get(p.playerId) ?? p.remaining)
    })),
    pot: box,
    bankerId,
    // The banker's own line already carries the box, so show it separately.
    bankerCovered: round(-Math.min(0, box.boxCash)),
    // Chips must reconcile before settlement is trustworthy.
    unreconciled: round(box.chipsInPlay)
  };
}

/** Validate a proposed buy-in against room policy. Returns {ok, reason, short}. */
function checkBuyIn(room, amount, isAdmin) {
  const c = room.config || {};
  const min = c.minBuyIn ?? 5;
  const std = c.defaultBuyIn ?? 20;
  const inc = c.buyInIncrement || 1;
  if (!(amount > 0)) return { ok: false, reason: 'Enter an amount above zero.' };
  if (amount > (c.maxBuyIn || 100000)) {
    return { ok: false, reason: `The most you can buy in for here is ${c.maxBuyIn}.` };
  }
  if (inc > 0 && Math.abs(Math.round(amount / inc) * inc - amount) > 0.001) {
    return { ok: false, reason: `Buy-ins go in steps of ${inc}.` };
  }
  const short = amount < std;
  if (short && amount < min) {
    return { ok: false, reason: `The table minimum is ${min}.` };
  }
  if (short && !c.allowShortBuy && !isAdmin) {
    return { ok: false, reason: `This table wants the full ${std}. Ask the room admin to approve a short buy.`, needsApproval: true, short: true };
  }
  return { ok: true, short };
}

module.exports = { positions, potState, settle, checkBuyIn, round, live };
