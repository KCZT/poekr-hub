'use strict';
/**
 * Points the app's storage at a throwaway directory, and must be required
 * before anything that touches the app — the paths are read once, when the
 * store module loads.
 *
 * Without this the suites write accounts, rooms and whole sessions into
 * whichever install they are run from, and one of them deletes the folder
 * afterwards. On a laptop that costs you a test fixture. On the server holding
 * your poker history it costs you the history.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pokerhub-test-'));
fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
for (const kind of ['avatars', 'photos', 'sounds', 'brand']) {
  fs.mkdirSync(path.join(dir, 'uploads', kind), { recursive: true });
}

process.env.POKERHUB_DATA = path.join(dir, 'data');
process.env.POKERHUB_UPLOADS = path.join(dir, 'uploads');

/** Back to an empty install, so a suite can be run twice in a row. */
function reset() {
  const data = process.env.POKERHUB_DATA;
  if (!fs.existsSync(data)) return;
  for (const f of fs.readdirSync(data)) {
    const p = path.join(data, f);
    if (f === 'cert') fs.rmSync(p, { recursive: true, force: true });
    else if (f.endsWith('.json')) fs.unlinkSync(p);
  }
}

function cleanUp() {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
}

/*
 * The store flushes pending writes from its own exit handler, and this module
 * loads first, so a naive cleanup here would delete the directory out from
 * under that flush: the process dies with an ENOENT on the way out, and a suite
 * whose checks all passed still reports failure.
 *
 * Rather than depend on handler ordering or a timer that a fast synchronous
 * suite exits before reaching, this flushes the store itself and then deletes.
 * The store is only prodded if something already loaded it — requiring it from
 * here would build the directory back up again a moment after removing it.
 */
process.on('exit', () => {
  const storePath = require.resolve('../../src/store');
  if (require.cache[storePath]) {
    try { require.cache[storePath].exports.db.flushNow(); } catch { /* nothing pending */ }
  }
  cleanUp();
});

module.exports = { dir, reset, cleanUp };
