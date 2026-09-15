'use strict';
/** Live updates over Server-Sent Events: no extra deps, reconnects on its own. */

const channels = new Map(); // roomId -> Set(res)

function subscribe(roomId, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  res.write(`retry: 3000\n\n`);

  if (!channels.has(roomId)) channels.set(roomId, new Set());
  channels.get(roomId).add(res);

  const beat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* closed */ }
  }, 25000);

  const close = () => {
    clearInterval(beat);
    channels.get(roomId)?.delete(res);
    if (channels.get(roomId)?.size === 0) channels.delete(roomId);
  };
  res.on('close', close);
  res.on('error', close);
}

function publish(roomId, type, payload) {
  const set = channels.get(roomId);
  if (!set) return;
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
  for (const res of set) {
    try { res.write(frame); } catch { set.delete(res); }
  }
}

function listenerCount(roomId) { return channels.get(roomId)?.size || 0; }

module.exports = { subscribe, publish, listenerCount };
