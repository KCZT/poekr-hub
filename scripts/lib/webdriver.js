'use strict';
/**
 * A very small W3C WebDriver client.
 *
 * WebKitWebDriver speaks the standard protocol over plain HTTP, so driving a
 * real WebKit build needs nothing installed beyond the driver itself. Writing
 * the twenty lines here beats adding selenium to an app whose whole pitch is
 * that it runs on a laptop with two dependencies.
 */
const { spawn } = require('child_process');

class Session {
  constructor(base, id) {
    this.base = base;
    this.id = id;
  }

  async send(method, path, body) {
    const res = await fetch(`${this.base}/session/${this.id}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    if (json.value && json.value.error) {
      throw new Error(`${json.value.error}: ${json.value.message || ''}`.slice(0, 300));
    }
    return json.value;
  }

  go(url) { return this.send('POST', '/url', { url }); }

  /** Runs in the page and returns a JSON-serialisable result. */
  eval(fn, ...args) {
    return this.send('POST', '/execute/sync', {
      script: `return (${fn.toString()}).apply(null, arguments)`,
      args
    });
  }

  setWindow(width, height) {
    return this.send('POST', '/window/rect', { width, height, x: 0, y: 0 });
  }

  quit() {
    return fetch(`${this.base}/session/${this.id}`, { method: 'DELETE' }).catch(() => {});
  }
}

/**
 * Starts Xvfb and WebKitWebDriver, then opens a session.
 * Returns null when the pieces are not installed, so a suite can skip politely
 * rather than fail on a machine that was never set up for it.
 */
async function startWebKit(opts = {}) {
  // A previous run may still be holding a display or a port, so pick fresh
  // ones rather than failing in a way that looks like WebKit is not installed.
  const pick = 20 + Math.floor(Math.random() * 60);
  const port = opts.port || 4400 + pick;
  const display = opts.display || `:${pick}`;
  const procs = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1400x1200x24'], { stdio: 'ignore' });
  xvfb.on('error', () => {});
  procs.push(xvfb);
  await wait(1500);

  const driver = spawn('WebKitWebDriver', [`--port=${port}`], {
    stdio: 'ignore',
    env: { ...process.env, DISPLAY: display }
  });
  driver.on('error', () => {});
  procs.push(driver);

  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${base}/status`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() - started > 12000) {
      procs.forEach((p) => p.kill());
      return null;
    }
    await wait(300);
  }

  const res = await fetch(`${base}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      capabilities: {
        alwaysMatch: {
          'webkitgtk:browserOptions': {
            binary: '/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser',
            args: ['--automation']
          },
          acceptInsecureCerts: true
        }
      }
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!json.value || !json.value.sessionId) {
    procs.forEach((p) => p.kill());
    return null;
  }

  const session = new Session(base, json.value.sessionId);
  session.version = json.value.capabilities?.browserVersion || 'unknown';
  session.close = async () => {
    await session.quit();
    procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } });
  };
  return session;
}

module.exports = { startWebKit };
