import { state } from './api.js';

/**
 * Alerts for a phone in someone's pocket.
 *
 * These fire from the live connection the page already holds open, which means
 * they work with no internet and no push service — but only while the app is
 * open, even if it is in the background. That trade is the right way round for
 * something running on the wifi in someone's kitchen.
 */

/**
 * Whether this browser has notifications at all.
 *
 * iOS Safari has no Notification object whatsoever in an ordinary tab — it
 * appears only once the app has been added to the home screen. `typeof` is the
 * only safe way to ask: writing `Notification?.permission` throws a
 * ReferenceError there, because optional chaining forgives a null value but not
 * an identifier that was never declared. That throw used to happen while this
 * module was still loading, which took the whole app down to a blank page.
 */
function supported() {
  return typeof Notification !== 'undefined';
}

let granted = supported() && Notification.permission === 'granted';

export function status() {
  // Browsers switch these off entirely outside a secure context, and a phone on
  // http://192.168.x.x is not one. Say so rather than offer a dead button.
  if (!window.isSecureContext) return 'insecure';
  if (!supported()) return 'unsupported';
  return Notification.permission;
}

export async function ask() {
  if (!window.isSecureContext) return 'insecure';
  if (!supported()) return 'unsupported';
  try {
    const result = await Notification.requestPermission();
    granted = result === 'granted';
    return result;
  } catch {
    return 'denied';
  }
}

function buzz(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* not supported */ }
}

function badge(n) {
  try {
    if (n > 0) navigator.setAppBadge?.(n);
    else navigator.clearAppBadge?.();
  } catch { /* not supported */ }
}

/**
 * @param {string} title
 * @param {{body?: string, tag?: string, urgent?: boolean, force?: boolean}} opts
 */
export async function alert(title, { body = '', tag = 'pokerhub', urgent = false, force = false } = {}) {
  buzz(urgent ? [90, 60, 90, 60, 160] : [70]);
  // A visible page already shows a toast; a second popup on top is just noise.
  if (!granted || (!document.hidden && !force)) return;
  const options = {
    body,
    tag,
    renotify: true,
    icon: '/brand/icon',
    badge: '/brand/icon',
    silent: state.muted
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg?.showNotification) return reg.showNotification(title, options);
    if (supported()) return new Notification(title, options);
  } catch { /* browser said no */ }
}

/** Count of things waiting on this person, shown on the tab and app icon. */
export function setPending(n) {
  badge(n);
  const base = state.boot?.siteName || 'Poker Hub';
  document.title = n > 0 ? `(${n}) ${base}` : base;
}
