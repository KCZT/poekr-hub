'use strict';
/**
 * Guessing protection for anything that checks a secret.
 *
 * A four digit PIN is 10,000 combinations, which is minutes of work for anyone
 * on the same wifi. Backing off after a handful of misses turns that into years
 * without getting in the way of someone who fat-fingered their own password.
 *
 * Counting is per account and per device, so one person mistyping cannot lock
 * the table out, and one device cannot work through every account either.
 */

const attempts = new Map(); // key -> { count, until, last }

/**
 * Two budgets, deliberately far apart.
 *
 * Per account is the real defence and is strict. Per device is only there to
 * stop one phone working through every account in turn, so it is loose — the
 * host's laptop is a shared device by design, with several people tapping in
 * PINs on it, and one person fumbling theirs must not lock out the table.
 */
const BUDGET = {
  s: { free: 4, steps: [5, 15, 60, 300, 900] },   // per account
  d: { free: 30, steps: [5, 15, 60] }             // per device
};
const FORGET_AFTER = 1000 * 60 * 60; // a quiet hour wipes the slate

function prune() {
  const cutoff = Date.now() - FORGET_AFTER;
  for (const [key, rec] of attempts) {
    if (rec.last < cutoff && (!rec.until || rec.until < Date.now())) attempts.delete(key);
  }
}
setInterval(prune, 1000 * 60 * 10).unref?.();

function ipOf(req) {
  return (req.ip || req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

/**
 * @returns {{blocked: boolean, retryIn?: number}} seconds until the next try
 */
function check(req, subject) {
  const now = Date.now();
  for (const key of [`s:${subject}`, `d:${ipOf(req)}`]) {
    const rec = attempts.get(key);
    if (rec?.until && rec.until > now) {
      return { blocked: true, retryIn: Math.ceil((rec.until - now) / 1000) };
    }
  }
  return { blocked: false };
}

function fail(req, subject) {
  const now = Date.now();
  for (const key of [`s:${subject}`, `d:${ipOf(req)}`]) {
    const budget = BUDGET[key[0]];
    const rec = attempts.get(key) || { count: 0, until: 0, last: now };
    rec.count += 1;
    rec.last = now;
    if (rec.count > budget.free) {
      const step = budget.steps[Math.min(rec.count - budget.free - 1, budget.steps.length - 1)];
      rec.until = now + step * 1000;
    }
    attempts.set(key, rec);
  }
}

/** Getting in clears your own slate, and eases the device count back down. */
function succeed(req, subject) {
  attempts.delete(`s:${subject}`);
  const key = `d:${ipOf(req)}`;
  const rec = attempts.get(key);
  if (rec) {
    rec.count = Math.max(0, rec.count - BUDGET.d.free);
    rec.until = 0;
    if (rec.count === 0) attempts.delete(key);
  }
}

function wait(seconds) {
  if (seconds >= 60) {
    const mins = Math.ceil(seconds / 60);
    return `${mins} minute${mins === 1 ? '' : 's'}`;
  }
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

/**
 * Wraps a handler that checks a secret. `subject` names what is being guessed
 * at, so attempts against one account do not lock a different one.
 */
function guard(subjectOf) {
  return (req, res, next) => {
    const subject = subjectOf(req);
    if (!subject) return next();
    const state = check(req, subject);
    if (state.blocked) {
      return res.status(429).json({
        error: `Too many tries. Wait ${wait(state.retryIn)} and try again.`,
        retryIn: state.retryIn
      });
    }
    req.limiter = {
      subject,
      fail: () => fail(req, subject),
      succeed: () => succeed(req, subject)
    };
    next();
  };
}

module.exports = { guard };
