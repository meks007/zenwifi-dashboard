// Centralised in-memory ring-buffer logger.
// Buffer size and debug flag are set at runtime from config via
// setMaxLines(n) and setDebug(bool), called from index.js after config loads.

let MAX_LINES = 500;
let buffer = [];
let wsBroadcast = null;
let debugEnabled = false;

function setMaxLines(n) {
  MAX_LINES = (Number.isInteger(n) && n > 0) ? n : 500;
  // Trim existing buffer if new limit is smaller
  if (buffer.length > MAX_LINES) buffer = buffer.slice(buffer.length - MAX_LINES);
}

function setDebug(enabled) {
  debugEnabled = !!enabled;
}

function setBroadcaster(fn) {
  wsBroadcast = fn;
}

function nowIso() {
  return new Date().toISOString();
}

function pushLine(level, msg, meta) {
  const entry = {
    ts: nowIso(),
    level: level,
    msg: msg,
    meta: meta || null,
  };

  buffer.push(entry);
  if (buffer.length > MAX_LINES) buffer = buffer.slice(buffer.length - MAX_LINES);

  const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
  process.stdout.write('[' + entry.ts + '] [' + level.toUpperCase() + '] ' + msg + metaStr + '\n');

  if (wsBroadcast) {
    try { wsBroadcast({ type: 'log', entry: entry }); } catch (_) {}
  }
}

function info(msg, meta) { pushLine('info', msg, meta); }
function warn(msg, meta) { pushLine('warn', msg, meta); }
function error(msg, meta) { pushLine('error', msg, meta); }

function debug(msg, meta) {
  if (!debugEnabled) return;
  pushLine('debug', msg, meta);
}

function list() {
  return buffer.slice();
}

module.exports = { info, warn, error, debug, list, setBroadcaster, setDebug, setMaxLines };
