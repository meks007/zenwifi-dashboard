// Simple in-memory log buffer + stdout logger.
// Intended for home-lab use; no PII redaction.

const MAX_LINES = parseInt(process.env.LOG_MAX_LINES || '500', 10);

let buffer = [];
let wsBroadcast = null; // function(payload)

function setBroadcaster(fn) {
  wsBroadcast = fn;
}

function nowIso() {
  return new Date().toISOString();
}

function pushLine(level, msg, meta) {
  const entry = {
    ts: nowIso(),
    level,
    msg,
    meta: meta || null,
  };

  buffer.push(entry);
  if (buffer.length > MAX_LINES) buffer = buffer.slice(buffer.length - MAX_LINES);

  const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
  // Always log to stdout
  console.log('[' + entry.ts + ']' + ' [' + level.toUpperCase() + '] ' + msg + metaStr);

  if (wsBroadcast) {
    try {
      wsBroadcast({ type: 'log', entry });
    } catch (_) {}
  }
}

function info(msg, meta) { pushLine('info', msg, meta); }
function warn(msg, meta) { pushLine('warn', msg, meta); }
function error(msg, meta) { pushLine('error', msg, meta); }
function debug(msg, meta) {
  const enabled = process.env.DEBUG_LOGGING === '1' || process.env.DEBUG_LOGGING === 'true';
  if (!enabled) return;
  pushLine('debug', msg, meta);
}

function list() {
  return buffer.slice();
}

module.exports = { info, warn, error, debug, list, setBroadcaster };
