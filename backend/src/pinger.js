'use strict';

// ---------------------------------------------------------------------------
// Pinger - reachability checks for discovered (non-WiFi) clients
//
// Runs 3 ICMP pings per client every N minutes (configurable).
// Uses the system ping binary via child_process so no extra npm package
// is needed. Works on Linux (Docker) and macOS.
//
// Public API:
//   pinger.start(intervalMinutes, onStateChange)
//     - intervalMinutes : how often to re-ping all known clients (default 5)
//     - onStateChange   : called with (mac, online) whenever reachability flips
//
//   pinger.setClients(entries)
//     - entries: array of { mac, ip } for all currently known discovered clients
//     - call this every time the discovered client list changes
//
//   pinger.triggerCycle()
//     - run a ping cycle NOW if the interval has elapsed (or no cycle has run yet)
//     - safe to call on every poll; the pinger decides internally whether it's due
//     - does nothing if a cycle is already in progress
//
//   pinger.pingClient(mac)
//     - immediately ping a single known client, bypassing the interval guard
//     - runs the full online/offline flip logic and fires onStateChange if needed
//     - resolves to { online, sent, received, flipped } or rejects if mac unknown
//
//   pinger.getStatus(mac)
//     - returns { online: bool, checkedAt: Date|null, last_ping_at: string|null,
//                 last_ping_result: string|null } or null if unknown
//
//   pinger.isOnline(mac)
//     - convenience shorthand; returns true / false / null (unknown yet)
// ---------------------------------------------------------------------------

const { exec } = require('child_process');
const logger   = require('./logger');
const db       = require('./db');

// mac -> { ip, online: bool|null, checkedAt: Date|null,
//           last_ping_at: string|null, last_ping_result: string|null }
const statusMap = new Map();

// { mac, ip } for the current set of discovered clients
let knownClients = [];

let _onStateChange    = null;
let _cycleRunning     = false;
let _intervalMs       = 5 * 60 * 1000; // default 5 minutes; updated by start()
let _lastCycleStartAt = 0;             // epoch ms of when the last cycle began

/**
 * Ping a single IP address with 3 packets, 1 s timeout per packet.
 * Resolves to { online: bool, sent: number, received: number }.
 */
function pingOne(ip) {
  return new Promise(function(resolve) {
    var cmd = 'ping -c 3 -W 1 -w 3 ' + ip + ' 2>&1';
    exec(cmd, function(err, stdout) {
      var sent     = 3;
      var received = 0;
      var m = stdout && stdout.match(/(\d+) packets transmitted,\s*(\d+) (?:packets )?received/);
      if (m) {
        sent     = parseInt(m[1], 10);
        received = parseInt(m[2], 10);
      } else if (!err) {
        received = sent;
      }
      resolve({ online: received > 0, sent: sent, received: received });
    });
  });
}

/**
 * Apply a ping result for a single client entry: update statusMap and fire
 * onStateChange if the online/offline state flipped.
 * DB persistence is intentionally NOT done here -- callers are responsible
 * for persisting after all pings for a client are complete.
 * Returns { online, sent, received, flipped }.
 */
function applyPingResult(entry, result) {
  var online    = result.online;
  var resultStr = result.received + '/' + result.sent;
  var prev      = statusMap.get(entry.mac);
  var flipped   = !prev || prev.online !== online;
  var now       = new Date();

  statusMap.set(entry.mac, {
    ip:               entry.ip,
    online:           online,
    checkedAt:        now,
    last_ping_at:     now.toISOString(),
    last_ping_result: resultStr,
  });

  if (flipped) {
    logger.info('[Pinger] ' + entry.mac + ' (' + entry.ip + ') is now ' + (online ? 'ONLINE' : 'OFFLINE'));
    if (_onStateChange) _onStateChange(entry.mac, online);
  }

  return { online: online, sent: result.sent, received: result.received, flipped: flipped };
}

/**
 * Persist the current statusMap entry for a MAC to the DB.
 */
function persistPingState(mac) {
  var s = statusMap.get(mac);
  if (!s) return;
  try {
    db.setLastPing(mac, s.last_ping_at, s.last_ping_result);
  } catch (dbErr) {
    logger.error('[Pinger] Failed to persist last_ping for ' + mac + ': ' + dbErr.message);
  }
}

/**
 * Ping all currently known discovered clients sequentially.
 * DB state is written once per client after its ping completes.
 */
async function runPingCycle() {
  if (_cycleRunning) {
    logger.debug('[Pinger] Cycle already in progress, skipping trigger');
    return;
  }
  if (knownClients.length === 0) return;

  _cycleRunning     = true;
  _lastCycleStartAt = Date.now();

  logger.info('[Pinger] Starting ping cycle for ' + knownClients.length + ' client(s)');

  var snapshot = knownClients.slice();
  for (var i = 0; i < snapshot.length; i++) {
    var entry = snapshot[i];
    if (!entry.ip) continue;
    logger.debug('[Pinger] Pinging ' + entry.mac + ' (' + entry.ip + ')');
    var result = await pingOne(entry.ip);
    logger.debug(
      '[Pinger] Result for ' + entry.mac + ' (' + entry.ip + '): ' +
      result.received + '/' + result.sent + ' packets received -> ' +
      (result.online ? 'ONLINE' : 'OFFLINE')
    );
    applyPingResult(entry, result);
    persistPingState(entry.mac);
  }

  _cycleRunning = false;
  logger.info('[Pinger] Ping cycle complete');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function setClients(entries) {
  knownClients = (entries || []).filter(function(e) { return e.ip; });

  var currentMacs = new Set(knownClients.map(function(e) { return e.mac; }));
  statusMap.forEach(function(_, mac) {
    if (!currentMacs.has(mac)) statusMap.delete(mac);
  });

  // Pre-seed statusMap from DB for any client not yet tracked so that
  // previously-offline clients are not briefly shown as online before the
  // first ping cycle completes after a backend restart.
  knownClients.forEach(function(entry) {
    if (statusMap.has(entry.mac)) return; // already tracked in this session
    var dbPing = db.getLastPing(entry.mac);
    if (!dbPing || !dbPing.last_ping_result) return;
    var parts    = dbPing.last_ping_result.split('/');
    var received = parseInt(parts[0], 10);
    var sent     = parseInt(parts[1], 10);
    var online   = !isNaN(received) && !isNaN(sent) && received > 0 && received === sent;
    statusMap.set(entry.mac, {
      ip:               entry.ip,
      online:           online,
      checkedAt:        new Date(dbPing.last_ping_at),
      last_ping_at:     dbPing.last_ping_at,
      last_ping_result: dbPing.last_ping_result,
    });
    logger.debug('[Pinger] Restored persisted ping state for ' + entry.mac + ': ' +
      (online ? 'online' : 'offline') + ' (' + dbPing.last_ping_result + ')');
  });
}

/**
 * Trigger a ping cycle if the configured interval has elapsed.
 * Safe to call on every poll(). Does nothing if a cycle is already running.
 */
function triggerCycle() {
  var due = (Date.now() - _lastCycleStartAt) >= _intervalMs;
  if (!due) return;
  runPingCycle().catch(function(err) {
    logger.error('[Pinger] Unexpected error in triggered cycle: ' + err.message);
  });
}

/**
 * Immediately ping a single known client, bypassing the interval guard.
 * Runs the full online/offline flip logic and fires onStateChange if needed.
 * Persists the result to DB after the ping completes.
 * Resolves to { online, sent, received, flipped }.
 * Rejects if the MAC is not in the known client list or has no IP.
 */
async function pingClient(mac) {
  var entry = knownClients.find(function(e) { return e.mac === mac; });
  if (!entry)    throw new Error('MAC ' + mac + ' not in known client list');
  if (!entry.ip) throw new Error('MAC ' + mac + ' has no IP, cannot ping');

  logger.info('[Pinger] Manual ping for ' + mac + ' (' + entry.ip + ')');
  var result = await pingOne(entry.ip);
  logger.debug(
    '[Pinger] Manual result for ' + mac + ': ' +
    result.received + '/' + result.sent + ' -> ' +
    (result.online ? 'ONLINE' : 'OFFLINE')
  );
  var applied = applyPingResult(entry, result);
  persistPingState(mac);
  return applied;
}

function getStatus(mac) {
  return statusMap.get(mac) || null;
}

function isOnline(mac) {
  var s = statusMap.get(mac);
  if (!s) return null;
  return s.online;
}

function start(intervalMinutes, onStateChange) {
  var mins      = intervalMinutes || 5;
  _intervalMs   = mins * 60 * 1000;
  _onStateChange = onStateChange || null;
  logger.info('[Pinger] Starting; will ping discovered clients every ' + mins + ' minute(s)');
}

module.exports = { start, setClients, triggerCycle, pingClient, getStatus, isOnline };
