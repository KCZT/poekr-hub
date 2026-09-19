'use strict';
/**
 * Two ways to run this, and they want opposite defaults.
 *
 * On a kitchen table, the people who can reach the app are the people in the
 * room, so it leans open: reading a table needs no sign-in and an account can
 * skip having a password at all.
 *
 * On a public address none of that holds. Setting PUBLIC_URL switches the whole
 * posture over at once rather than leaving a row of switches for someone to get
 * half right: reads require a sign-in, passwordless accounts stop being a way
 * in, and the app stops trying to manage its own certificate because something
 * in front of it is doing that properly.
 */

const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '') || null;
const hosted = !!PUBLIC_URL;

if (PUBLIC_URL && !/^https?:\/\/[^/\s]+$/.test(PUBLIC_URL)) {
  console.error(`\n  PUBLIC_URL does not look like an address: ${PUBLIC_URL}`);
  console.error('  It should be the whole origin and nothing else, e.g. https://poker.example.com\n');
  process.exit(1);
}
if (PUBLIC_URL && PUBLIC_URL.startsWith('http://')) {
  console.warn('\n  PUBLIC_URL is http, not https. Sign-ins will cross the internet in the clear,');
  console.warn('  and phones will refuse notifications and home-screen install.\n');
}

const config = {
  /** The address people actually type, or null on a local network. */
  publicUrl: PUBLIC_URL,

  /** True when something else terminates TLS and forwards to us. */
  hosted,

  /**
   * Which hops to believe about the original client. 'loopback' covers Caddy or
   * nginx on the same machine, which is the normal case. Override only if the
   * proxy is somewhere else, and never set it to true on a public box — that
   * takes any client's word for its own address and hands them the rate limiter.
   */
  trustProxy: process.env.TRUST_PROXY || (hosted ? 'loopback' : false),

  /** Behind a proxy there is no reason to answer anyone but the proxy. */
  bind: process.env.BIND || (hosted ? '127.0.0.1' : '0.0.0.0'),

  port: Number(process.env.PORT) || 3000,

  /** The app's own self-signed certificate is pointless behind a real one. */
  get selfSignedTls() {
    if (hosted) return false;
    return process.env.DISABLE_TLS !== '1';
  },

  securePort: Number(process.env.HTTPS_PORT) || (Number(process.env.PORT) || 3000) + 443,

  /** Reading a table, the player list or the standings needs a sign-in. */
  get requireAuthToRead() { return hosted; },

  /** Tapping a name with no password is a local-network convenience only. */
  /**
   * Whether an account can exist, and sign in, with no password.
   *
   * Allowed everywhere by default, including on a public address, because the
   * people using this are sitting at a table together and being made to invent
   * a password to buy in for twenty dollars is the kind of friction that gets
   * an app abandoned.
   *
   * Be clear about what that costs on a public address, though: anyone who
   * finds the URL can sign in as any account that has no password, including
   * a poker admin. Set REQUIRE_PASSWORDS=1 to insist on one.
   */
  get allowPasswordlessAccounts() { return process.env.REQUIRE_PASSWORDS !== '1'; },

  /** True when the open door is reachable from outside the house. */
  get passwordlessOnPublicAddress() {
    return hosted && this.allowPasswordlessAccounts;
  }
};

module.exports = config;
