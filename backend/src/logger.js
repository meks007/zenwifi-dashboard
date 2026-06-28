'use strict';

// ---------------------------------------------------------------------------
// File-backed logger
//
// Every log entry is written to stdout AND appended to a rotating JSON-lines
// log file (when initFileLog() has been called). There is no in-memory ring
// buffer -- the file is the source of truth for history.
//
// Public API:
//   initFileLog(path, maxBytes, maxRotations)
//     Call once after config is loaded. Opens the append stream and stores
//     rotation settings. Safe to skip -- file logging is simply disabled.
//
//   tail(n)
//     Returns the last n entries across all available log files (current +
//     rotated), in chronological order. n=0 returns everything.
//
//   setBroadcaster(fn)
//     Registers the WebSocket broadcast function. Every subsequent pushLine
//     call will broadcast the entry live. No queue/flush needed -- clients
//     receive the tail on connect and live entries thereafter.
//
//   setDebug(bool) / isDebug()
//     Enable/disable debug-level output at runtime. isDebug() returns the
//     current state so callers (e.g. the API route) can read it back.
//
//   info / warn / error / debug
//     Standard log methods.
// ---------------------------------------------------------------------------

const fs   = require('fs');
const path = require('path');

var wsBroadcast  = null;
var debugEnabled = false;

// File logging state
var logFilePath     = null;
var logMaxBytes     = 10 * 1024 * 1024; // 10 MB
var logMaxRotations = 3;
var logStream       = null;

// ---------------------------------------------------------------------------
// File logging
// ---------------------------------------------------------------------------

function rotatedPath(n) {
  return logFilePath + '.' + n;
}

function rotate() {
  // Close current stream
  if (logStream) { try { logStream.end(); } catch (_) {} logStream = null; }

  // Shift existing rotations: .3 deleted, .2 -> .3, .1 -> .2, current -> .1
  for (var i = logMaxRotations; i >= 1; i--) {
    var older = rotatedPath(i);
    var newer = i === 1 ? logFilePath : rotatedPath(i - 1);
    if (fs.existsSync(newer)) {
      if (i === logMaxRotations) {
        try { fs.unlinkSync(older); } catch (_) {}
      }
      try { fs.renameSync(newer, older); } catch (_) {}
    }
  }

  // Open fresh stream on the current path
  logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
}

function purgeLogFiles() {
  // Delete the current log file and all rotated copies so every startup
  // begins with a completely fresh set of logs.
  for (var i = logMaxRotations; i >= 1; i--) {
    try { fs.unlinkSync(rotatedPath(i)); } catch (_) {}
  }
  try { fs.unlinkSync(logFilePath); } catch (_) {}
}

function initFileLog(filePath, maxBytes, maxRotations) {
  logFilePath     = filePath;
  logMaxBytes     = (maxBytes     > 0) ? maxBytes     : 10 * 1024 * 1024;
  logMaxRotations = (maxRotations > 0) ? maxRotations : 3;

  // Remove any log files left over from the previous run before writing
  // anything, so the client always sees a clean history on reconnect.
  purgeLogFiles();

  // Ensure the directory exists
  try { fs.mkdirSync(path.dirname(logFilePath), { recursive: true }); } catch (_) {}

  logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
  logStream.on('error', function(err) {
    process.stderr.write('[Logger] File write error: ' + err.message + '\n');
  });
}

function appendToFile(line) {
  if (!logStream) return;
  try {
    logStream.write(line + '\n');
    // Check size and rotate if needed
    var stat = fs.statSync(logFilePath);
    if (stat.size >= logMaxBytes) rotate();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// tail(n) -- read last n lines across all log files (0 = all)
// ---------------------------------------------------------------------------
function readFileLines(filePath) {
  try {
    var raw = fs.readFileSync(filePath, 'utf8');
    var entries = [];
    raw.split('\n').forEach(function(line) {
      line = line.trim();
      if (!line) return;
      try { entries.push(JSON.parse(line)); } catch (_) {}
    });
    return entries;
  } catch (_) {
    return [];
  }
}

function tail(n) {
  if (!logFilePath) return [];

  // Collect files oldest-first: .N, .N-1, ..., .1, current
  var files = [];
  for (var i = logMaxRotations; i >= 1; i--) {
    var p = rotatedPath(i);
    if (fs.existsSync(p)) files.push(p);
  }
  files.push(logFilePath);

  // Read all entries in chronological order
  var all = [];
  files.forEach(function(f) {
    readFileLines(f).forEach(function(e) { all.push(e); });
  });

  if (n === 0) return all;
  return all.slice(Math.max(0, all.length - n));
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

function setBroadcaster(fn) {
  wsBroadcast = fn;
}

function setDebug(enabled) {
  debugEnabled = !!enabled;
}

function isDebug() {
  return debugEnabled;
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

  var metaStr = meta ? ' ' + JSON.stringify(meta) : '';
  process.stdout.write('[' + entry.ts + '] [' + level.toUpperCase() + '] ' + msg + metaStr + '\n');

  appendToFile(JSON.stringify(entry));

  if (wsBroadcast) {
    try { wsBroadcast({ type: 'log', entry: entry }); } catch (_) {}
  }
}

function info(msg, meta)  { pushLine('info',  msg, meta); }
function warn(msg, meta)  { pushLine('warn',  msg, meta); }
function error(msg, meta) { pushLine('error', msg, meta); }

function debug(msg, meta) {
  if (!debugEnabled) return;
  pushLine('debug', msg, meta);
}

module.exports = { info, warn, error, debug, tail, setBroadcaster, setDebug, isDebug, initFileLog };
