'use strict';
// Storage goes to a throwaway directory; must be first.
require('./lib/sandbox');
/**
 * Reads the client code against what the target browsers actually support.
 *
 * This exists because two of the engines that matter cannot be run here.
 * Firefox's builds are not reachable from this machine, and the WebKit that is
 * installable is the GTK port rather than Safari itself — close, but it carries
 * APIs that iOS Safari withholds, which is exactly how the blank-page bug got
 * through in the first place.
 *
 * So rather than pretend, this reads the source and asks two questions of every
 * risky thing it finds:
 *
 *   would this throw on a target browser, taking the file with it
 *   or would it merely do nothing, which is fine
 *
 * A feature that is absent somewhere is not a problem. A feature that is absent
 * somewhere and reached without a guard is.
 *
 * The floors below are the oldest versions this app promises to run on. They
 * are worth re-checking against caniuse.com when raising them.
 */
const fs = require('fs');
const path = require('path');

const BASELINE = { safari: '15.4', ios: '15.4', firefox: '91' };

/**
 * `guard` says what makes a use of this safe.
 * `fatal` means an unguarded use throws and takes the whole module with it;
 * anything else merely misbehaves.
 */
const JS_FEATURES = [
  {
    name: 'bare Notification global',
    // A bare identifier, not a property access, and not inside a typeof.
    re: /(?<![.\w$'"`])Notification\s*(\?\.|\.)/g,
    absentOn: 'iOS Safari outside an installed web app',
    fatal: true,
    guard: /typeof\s+Notification/
  },
  {
    name: 'navigator.vibrate',
    re: /navigator\.vibrate/g,
    absentOn: 'every Safari',
    fatal: false,
    guard: /navigator\.vibrate\?\.|try\s*\{/
  },
  {
    name: 'navigator.setAppBadge',
    re: /navigator\.(set|clear)AppBadge/g,
    absentOn: 'Firefox and iOS Safari',
    fatal: false,
    guard: /AppBadge\?\.|try\s*\{/
  },
  {
    name: 'navigator.wakeLock',
    re: /navigator\.wakeLock/g,
    absentOn: 'Safari before 16.4, Firefox before 126',
    fatal: false,
    guard: /'wakeLock'\s+in\s+navigator|try\s*\{/
  },
  {
    name: 'navigator.share',
    re: /navigator\.share\b/g,
    absentOn: 'Firefox on the desktop',
    fatal: false,
    guard: /if\s*\(navigator\.share|navigator\.share\?\./
  },
  {
    name: 'regular expression lookbehind',
    re: /\(\?<[=!]/g,
    absentOn: 'Safari before 16.4',
    // Lookbehind fails when the pattern is compiled, so it takes the file down
    // even if the line never runs.
    fatal: true,
    guard: /new RegExp/
  },
  { name: 'structuredClone', re: /\bstructuredClone\s*\(/g, absentOn: 'Safari before 15.4', fatal: true, guard: /typeof\s+structuredClone/ },
  { name: 'Object.hasOwn', re: /Object\.hasOwn\s*\(/g, absentOn: 'Safari before 15.4', fatal: true, guard: /Object\.hasOwn\s*\?\?/ },
  { name: 'AbortSignal.timeout', re: /AbortSignal\.timeout/g, absentOn: 'Safari before 16', fatal: true, guard: /AbortSignal\.timeout\s*\?\?|typeof\s+AbortSignal/ },
  { name: 'Array.prototype.toSorted', re: /\.toSorted\s*\(/g, absentOn: 'Safari before 16.4, Firefox before 115', fatal: true, guard: /\.toSorted\s*\?\?/ },
  { name: 'Array.prototype.at', re: /\.at\s*\(\s*-?\d/g, absentOn: 'Safari before 15.4', fatal: true, guard: /\.at\s*\?\?/ },
  { name: 'crypto.randomUUID', re: /crypto\.randomUUID/g, absentOn: 'Safari before 15.4', fatal: true, guard: /randomUUID\s*\?\.|typeof\s+crypto/ },
  { name: 'createImageBitmap', re: /createImageBitmap\s*\(/g, absentOn: 'older Safari, and the imageOrientation option is newer still', fatal: true, guard: /typeof\s+createImageBitmap/ },
  { name: 'speechSynthesis', re: /(?<![.\w$])speechSynthesis\./g, absentOn: 'nothing, but iOS needs a user gesture first', fatal: true, guard: /window\.speechSynthesis|typeof\s+speechSynthesis/ }
];

const CSS_FEATURES = [
  {
    name: 'backdrop-filter',
    re: /(?<!-webkit-)backdrop-filter\s*:/g,
    note: 'Safari wants the -webkit- prefix until 18',
    needs: /-webkit-backdrop-filter\s*:/,
    perRule: true
  },
  {
    name: 'dvh units',
    re: /:\s*[^;]*\d+dvh/g,
    note: 'Safari learned dvh in 15.4, Firefox in 101 — a vh line first costs nothing',
    needs: /\d+vh/,
    perRule: true
  },
  { name: ':has()', re: /:has\(/g, note: 'Firefox only from 121', needs: null, degrades: true },
  { name: 'text-wrap: balance', re: /text-wrap\s*:\s*balance/g, note: 'Safari 17.5, Firefox 121', needs: null, degrades: true },
  { name: 'scrollbar-width', re: /scrollbar-width\s*:/g, note: 'Safari only from 18.2 — the scrollbar just shows', needs: null, degrades: true },
  { name: 'accent-color', re: /accent-color\s*:/g, note: 'Safari 15.4, Firefox 92 — falls back to the default control colour', needs: null, degrades: true },
  { name: '@container', re: /@container/g, note: 'Safari 16, Firefox 110', needs: null, degrades: true }
];

let fails = 0;
let warnings = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ` — ${extra}` : ''}`);
};
const note = (label, extra) => {
  warnings++;
  console.log(`  --   ${label}${extra ? ` — ${extra}` : ''}`);
};

const ROOT = path.join(__dirname, '..');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

/** The few lines either side, which is where a guard would live. */
function contextAround(src, index, radius = 400) {
  return src.slice(Math.max(0, index - radius), index + radius);
}

/**
 * Finds local predicates that do the checking on someone else's behalf, so
 * `if (!supported()) return;` counts as a guard rather than reading as a bare
 * use two lines later. Without this the analyser punishes the tidier code.
 */
function blankHelperBodies(code, names) {
  let out = code;
  for (const name of names) {
    const re = new RegExp(
      `(?:function\\s+${name}\\s*\\([^)]*\\)\\s*\\{[^}]*\\}`
      + `|(?:const|let)\\s+${name}\\s*=\\s*\\([^)]*\\)\\s*=>\\s*\\{[^}]*\\})`, 'g');
    // The whole declaration goes, signature included. Leaving the signature
    // behind means `function supported() {` still reads as a call to it from
    // the line below, which is precisely the hole this closes.
    out = out.replace(re, (whole) => whole.replace(/[^\n]/g, ' '));
  }
  return out;
}

function guardHelpers(code, featureGuard) {
  const names = [];
  const fnRe = /(?:function\s+(\w+)\s*\([^)]*\)|(?:const|let)\s+(\w+)\s*=\s*\([^)]*\)\s*=>)\s*\{?([^}]*)\}?/g;
  let m;
  while ((m = fnRe.exec(code)) !== null) {
    const name = m[1] || m[2];
    const body = m[3] || '';
    if (name && featureGuard && featureGuard.test(body)) names.push(name);
  }
  return names;
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

(async () => {
  console.log(`\nAgainst Safari ${BASELINE.safari} / iOS ${BASELINE.ios} / Firefox ${BASELINE.firefox} and newer`);

  const jsFiles = walk('public').filter((f) => f.endsWith('.js'));
  const htmlFiles = walk('public').filter((f) => f.endsWith('.html'));

  console.log('\nJavaScript the target browsers might not have');
  const unguarded = [];
  const guarded = [];

  for (const file of [...jsFiles, ...htmlFiles]) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    // Comments explain the hazards; they are not uses of them.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

    for (const f of JS_FEATURES) {
      const helpers = guardHelpers(code, f.guard);
      const viaHelper = helpers.length
        ? new RegExp(`\\b(${helpers.join('|')})\\s*\\(`)
        : null;

      /*
       * Blank the helper's own body out before scanning. Otherwise its
       * `typeof Notification` sits a few lines above every use and reads as
       * proof that those uses are protected, which is how a real bug walked
       * straight past an earlier version of this check.
       */
      const scanned = helpers.length ? blankHelperBodies(code, helpers) : code;

      f.re.lastIndex = 0;
      let m;
      while ((m = f.re.exec(scanned)) !== null) {
        // A guard only counts if it runs first, so look behind the use, never
        // ahead of it.
        const before = scanned.slice(Math.max(0, m.index - 400), m.index);
        const isGuarded = (f.guard && f.guard.test(before)) || (viaHelper && viaHelper.test(before));
        const entry = `${file}:${lineOf(scanned, m.index)} ${f.name}`;
        if (isGuarded) guarded.push(entry);
        else unguarded.push({ entry, feature: f });
      }
    }
  }

  const fatalUnguarded = unguarded.filter((u) => u.feature.fatal);
  const softUnguarded = unguarded.filter((u) => !u.feature.fatal);

  ok('nothing that would throw is reached without a guard',
    fatalUnguarded.length === 0,
    fatalUnguarded.slice(0, 3).map((u) => `${u.entry} (absent on ${u.feature.absentOn})`).join('; '));

  ok('nothing that is simply absent is reached without a guard',
    softUnguarded.length === 0,
    softUnguarded.slice(0, 3).map((u) => `${u.entry} (absent on ${u.feature.absentOn})`).join('; '));

  ok('the risky calls that do exist are all guarded', guarded.length > 0,
    `${guarded.length} guarded use${guarded.length === 1 ? '' : 's'}`);

  console.log('\nCSS the target browsers might not have');
  const css = fs.readFileSync(path.join(ROOT, 'public/css/app.css'), 'utf8');
  const cssProblems = [];

  for (const f of CSS_FEATURES) {
    f.re.lastIndex = 0;
    const hits = [...css.matchAll(f.re)];
    if (!hits.length) continue;

    if (f.degrades) {
      note(`${f.name} used ${hits.length}×`, `${f.note}; degrades quietly`);
      continue;
    }
    // A prefix or fallback has to be in the same rule, not merely somewhere.
    for (const hit of hits) {
      const ruleStart = css.lastIndexOf('{', hit.index);
      const ruleEnd = css.indexOf('}', hit.index);
      const rule = css.slice(ruleStart, ruleEnd);
      if (f.needs && !f.needs.test(rule)) {
        cssProblems.push(`line ${lineOf(css, hit.index)}: ${f.name} without its fallback (${f.note})`);
      }
    }
  }
  ok('every prefixed or newer property has its fallback in the same rule',
    cssProblems.length === 0, cssProblems.slice(0, 3).join('; '));

  console.log('\nThings that must be true for a phone to behave');
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const shareHtml = fs.readFileSync(path.join(ROOT, 'public/share.html'), 'utf8');

  ok('the viewport opts into the safe areas',
    /viewport-fit=cover/.test(indexHtml) && /viewport-fit=cover/.test(shareHtml));
  ok('the layout actually uses them',
    /env\(safe-area-inset-bottom/.test(css) && /env\(safe-area-inset-top/.test(css));
  ok('every env() call carries a fallback for browsers without insets',
    [...css.matchAll(/env\(safe-area-inset-[a-z]+/g)].every((m) => {
      const tail = css.slice(m.index, css.indexOf(')', m.index));
      return tail.includes(',');
    }));
  ok('iOS is told not to reflow text on rotate', /text-size-adjust/.test(css));
  ok('the colour scheme is declared, so form controls match',
    /color-scheme/.test(css) || /name="color-scheme"/.test(indexHtml));
  ok('reduced motion is respected', /prefers-reduced-motion/.test(css));
  ok('touch targets are raised on a coarse pointer', /pointer:\s*coarse/.test(css));
  ok('nothing loads from a CDN that an offline table cannot reach',
    !/<script[^>]+src="https?:/.test(indexHtml));

  console.log('\nModule loading');
  ok('the app is one module graph, so a throw anywhere is visible in testing',
    /<script type="module"/.test(indexHtml));
  const bareImports = [];
  for (const file of jsFiles) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of src.matchAll(/^import\s+[^'"]*['"]([^'"]+)['"]/gm)) {
      if (!m[1].startsWith('.') && !m[1].startsWith('/')) bareImports.push(`${file}: ${m[1]}`);
    }
  }
  ok('no bare module specifiers, which browsers cannot resolve',
    bareImports.length === 0, bareImports.slice(0, 3).join(', '));

  console.log(`\n${fails === 0 ? 'All compatibility checks passed.' : `${fails} check(s) failed.`}`);
  if (warnings) console.log(`${warnings} note${warnings === 1 ? '' : 's'} above are graceful degradations, not faults.`);
  console.log('');
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
