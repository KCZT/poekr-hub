'use strict';
/**
 * Set or clear an account's password from a shell on the machine.
 *
 * The case this exists for: a table that ran on a laptop where nobody needed a
 * password gets moved to a public address, where everybody does. Without this
 * the poker admin would be locked out of their own install with no way back in.
 *
 *   npm run set-password riley
 *   npm run set-password riley -- --clear
 */
const readline = require('readline');
const { db, logAudit } = require('../src/store');
const A = require('../src/auth');

const args = process.argv.slice(2).filter((a) => a !== '--');
const username = args.find((a) => !a.startsWith('--'));
const clear = args.includes('--clear');

function usage(message) {
  if (message) console.error(`\n  ${message}`);
  console.error('\n  Usage:  npm run set-password <username>');
  console.error('          npm run set-password <username> -- --clear\n');
  if (db.players.length) {
    console.error('  Accounts here:');
    for (const p of db.players.filter((x) => !x.isGuest)) {
      const tags = [
        p.role === 'site_admin' ? 'poker admin' : null,
        p.passwordHash ? null : 'no password',
        p.disabled ? 'switched off' : null
      ].filter(Boolean);
      console.error(`    ${p.username}${tags.length ? `  (${tags.join(', ')})` : ''}`);
    }
    console.error('');
  }
  process.exit(1);
}

if (!username) usage('Name the account.');

const player = db.players.find((p) => p.username === username.toLowerCase().trim());
if (!player) usage(`No account called "${username}".`);

if (clear) {
  player.passwordHash = null;
  A.revokeAllFor(player.id);
  db.save('players');
  db.flushNow();
  logAudit(player.id, 'account.password_removed', { via: 'command line' });
  console.log(`\n  ${player.displayName} now has no password.`);
  console.log('  On a local network they sign in by tapping their name.');
  console.log('  On a public address they will not be able to sign in at all.\n');
  process.exit(0);
}

/** Read without echoing, so the password does not sit in the scrollback. */
function ask(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      if (['\n', '\r', '\u0004'].includes(String(char))) return;
      readline.moveCursor(process.stdout, -1000, 0);
      readline.clearLine(process.stdout, 1);
      process.stdout.write(prompt);
    };
    process.stdin.on('data', onData);
    rl.question(prompt, (answer) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

(async () => {
  console.log(`\n  Setting a password for ${player.displayName} (@${player.username})`);
  if (player.role === 'site_admin') console.log('  This account is a poker admin.');
  console.log('');

  const first = (await ask('  New password: ')).trim();
  if (first.length < 6) {
    console.error('\n  Too short — at least 6 characters.\n');
    process.exit(1);
  }
  const again = (await ask('  Again to confirm: ')).trim();
  if (first !== again) {
    console.error('\n  Those did not match. Nothing changed.\n');
    process.exit(1);
  }

  player.passwordHash = A.hash(first);
  A.revokeAllFor(player.id);
  db.save('players');
  db.flushNow();
  logAudit(player.id, 'account.password_changed', { via: 'command line' });
  console.log(`\n  Done. ${player.displayName} has been signed out everywhere and can sign in with it now.\n`);
  process.exit(0);
})();
