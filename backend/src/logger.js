'use strict';

// Centralised in-memory ring-buffer logger.
// Buffer size and debug mode are controlled at runtime via setMaxLines/setDebug,
// called from index.js after config is loaded.
//
// Startup broadcast guarantee:
//   All log entries written before setBroadcaster() is called are queued in
//   pendingBroadcasts. The moment setBroadcaster() is called the queue is
//   flushed synchronously so no startup message is ever dropped from the
//   live WebSocket stream.

var maxLines = 500;
var buffer   = [];
var wsBroadcast      = null;
var pendingBroadcasts = [];
var debugEnabled = false;

function setDebug(enabled) {
  debugEnabled = !!enabled;
}

function setMaxLines(n) {
  maxLines = (n && n > 0) ? n : 500;
  // Trim existing buffer if it already exceeds the new limit
  if (buffer.length > maxLines) {
    buffer = buffer.slice(buffer.length - maxLines);
  }
}

function setBroadcaster(fn) {
  wsBroadcast = fn;
  // Flush every entry that was logged before the WS server was wired up.
  // These are already in the ring buffer; we just need to broadcast them now.
  if (pendingBroadcasts.length > 0) {
    pendingBroadcasts.forEach(function(entry) {
      try { wsBroadcast({ type: 'log', entry: entry }); } catch (_) {}
    });
    pendingBroadcasts = [];
  }
}

function nowIso() {
  return new Date().toISOString();
}

function pushLine(level, msg, meta) {
  var entry = {
    ts:    nowIso(),
    level: level,
    msg:   msg,
    meta:  meta || null,
  };

  buffer.push(entry);
  if (buffer.length > maxLines) {
    buffer = buffer.slice(buffer.length - maxLines);
  }

  var metaStr = meta ? ' ' + JSON.stringify(meta) : '';
  process.stdout.write('[' + entry.ts + '] [' + level.toUpperCase() + '] ' + msg + metaStr + '\n');

  if (wsBroadcast) {
    try { wsBroadcast({ type: 'log', entry: entry }); } catch (_) {}
  } else {
    // WS not ready yet -- queue for flush when setBroadcaster() is called.
    pendingBroadcasts.push(entry);
  }
}

function info(msg, meta)  { pushLine('info',  msg, meta); }
function warn(msg, meta)  { pushLine('warn',  msg, meta); }
function error(msg, meta) { pushLine('error', msg, meta); }

function debug(msg, meta) {
  if (!debugEnabled) return;
  pushLine('debug', msg, meta);
}

function list() {
  return buffer.slice();
}

module.exports = { info, warn, error, debug, list, setBroadcaster, setDebug, setMaxLines };
