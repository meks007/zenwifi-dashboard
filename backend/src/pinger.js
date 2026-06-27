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
//   pinger.getStatus(mac)
//     - returns { online: bool, checkedAt: Date|null } or null if unknown
//
//   pinger.isOnline(mac)
//     - convenience shorthand; returns true / false / null (unknown yet)
// ---------------------------------------------------------------------------

const { exec } = require('child_process');
const logger    = require('./logger');

// mac -> { ip, online: bool|null, checkedAt: Date|null }
const statusMap = new Map();

// mac -> { ip } for the current set of discovered clients
let knownClients = [];

let _onStateChange = null;

/**
 * Ping a single IP address with 3 packets, 1 s timeout per packet.
 * Resolves to true (reachable) or false (unreachable / error).
 */
function pingOne(ip) {
  return new Promise(function(resolve) {
    // -c 3   : send 3 packets
    // -W 1   : wait 1 s for each reply  (Linux)
    // -w 3   : overall deadline 3 s     (Linux)
    // macOS uses -t instead of -W; the -W flag is silently ignored there
    var cmd = 'ping -c 3 -W 1 -w 3 ' + ip + ' > /dev/null 2>&1';
    exec(cmd, function(err) {
      resolve(!err);
    });
  });
}

/**
 * Ping all currently known discovered clients sequentially (not in parallel
 * to avoid flooding the network on large deployments).
 */
async function runPingCycle() {
  if (knownClients.length === 0) return;

  logger.debug('[Pinger] Starting ping cycle for ' + knownClients.length + ' client(s)');

  for (var i = 0; i < knownClients.length; i++) {
    var entry = knownClients[i];
    if (!entry.ip) continue; // no IP -> cannot ping

    var online = await pingOne(entry.ip);
    var prev   = statusMap.get(entry.mac);

    var flipped = !prev || prev.online !== online;

    statusMap.set(entry.mac, {
      ip:        entry.ip,
      online:    online,
      checkedAt: new Date(),
    });

    if (flipped) {
      logger.info(
        '[Pinger] ' + entry.mac + ' (' + entry.ip + ') is now ' +
        (online ? 'ONLINE' : 'OFFLINE')
      );
      if (_onStateChange) _onStateChange(entry.mac, online);
    }
  }

  logger.debug('[Pinger] Ping cycle complete');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function setClients(entries) {
  knownClients = (entries || []).filter(function(e) { return e.ip; });

  // Remove stale entries from statusMap that are no longer in the client list
  var currentMacs = new Set(knownClients.map(function(e) { return e.mac; }));
  statusMap.forEach(function(_, mac) {
    if (!currentMacs.has(mac)) statusMap.delete(mac);
  });
}

function getStatus(mac) {
  return statusMap.get(mac) || null;
}

function isOnline(mac) {
  var s = statusMap.get(mac);
  if (!s) return null; // not checked yet -> treat as unknown (shown until first check)
  return s.online;
}

function start(intervalMinutes, onStateChange) {
  var mins = intervalMinutes || 5;
  _onStateChange = onStateChange || null;

  logger.info('[Pinger] Starting; will ping discovered clients every ' + mins + ' minute(s)');

  // Run immediately on startup, then on schedule
  runPingCycle();
  setInterval(runPingCycle, mins * 60 * 1000);
}

module.exports = { start, setClients, getStatus, isOnline };
