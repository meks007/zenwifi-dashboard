'use strict';

const { runSSH } = require('./ssh-transport');
const logger     = require('./logger');

var MAC_RE = new RegExp('^([0-9a-f]{2}:){5}[0-9a-f]{2}$');
function isMac(str) { return MAC_RE.test(str); }

// ---------------------------------------------------------------------------
// Interface / driver cache
//
// Keyed by ap.name. Each entry: { driver, ifaces, pollCount }
//
// Discovery is expensive: it opens several SSH connections per AP before the
// first assoclist query is even issued. Running it on every poll is unnecessary
// because the set of wireless interfaces almost never changes at runtime.
//
// Strategy:
//   - Run discovery on the very first poll (pollCount === 0).
//   - Re-run every `iface_discovery_interval` polls thereafter.
//   - Use the cached result for all other polls.
// ---------------------------------------------------------------------------
var ifaceCache = {};
var DEFAULT_IFACE_DISCOVERY_INTERVAL = 10;

async function resolveIfaceCache(ap, interval) {
  var entry = ifaceCache[ap.name];
  var rediscoverInterval = (typeof interval === 'number' && interval > 0)
    ? interval
    : DEFAULT_IFACE_DISCOVERY_INTERVAL;

  var needsDiscovery = (
    !entry ||
    entry.pollCount === 0 ||
    (entry.pollCount % rediscoverInterval) === 0
  );

  if (needsDiscovery) {
    logger.info(
      '[SSH] ' + ap.name + ' running interface discovery' +
      (entry ? ' (cycle ' + entry.pollCount + ')' : ' (initial)')
    );
    var driver = await detectDriver(ap);
    var ifaces = driver === 'atheros'
      ? await getInterfacesAtheros(ap)
      : await getInterfacesBroadcom(ap);
    ifaceCache[ap.name] = { driver: driver, ifaces: ifaces, pollCount: entry ? entry.pollCount : 0 };
  } else {
    logger.debug(
      '[SSH] ' + ap.name + ' using cached interfaces [' + entry.ifaces.join(', ') + '] (cycle ' + entry.pollCount + ')'
    );
  }

  return ifaceCache[ap.name];
}

function incrementPollCount(ap) {
  if (!ifaceCache[ap.name]) return;
  ifaceCache[ap.name].pollCount += 1;
}

// ---------------------------------------------------------------------------
// Driver detection
// ---------------------------------------------------------------------------
async function detectDriver(ap) {
  if (ap.driver) {
    var d = ap.driver.toLowerCase();
    if (d === 'broadcom' || d === 'atheros') {
      logger.info('[SSH] ' + ap.name + ' driver override: ' + d);
      return d;
    }
    logger.warn('[SSH] ' + ap.name + ' unknown driver override, falling back to auto-detect');
  }
  try {
    var out1 = await runSSH(ap, 'wl ver 2>/dev/null');
    if (out1 && out1.trim().length > 0) {
      logger.info('[SSH] ' + ap.name + ' driver detected: broadcom (wl ver succeeded)');
      return 'broadcom';
    }
  } catch (_) {}
  try {
    var out2 = await runSSH(ap, 'wlanconfig 2>/dev/null; echo $?');
    if (out2 && out2.trim().length > 0) {
      logger.info('[SSH] ' + ap.name + ' driver detected: atheros (wlanconfig present)');
      return 'atheros';
    }
  } catch (_) {}
  logger.warn('[SSH] ' + ap.name + ' could not detect driver, defaulting to broadcom');
  return 'broadcom';
}

// ---------------------------------------------------------------------------
// Broadcom helpers
// ---------------------------------------------------------------------------
async function probeIfaceBroadcom(ap, iface) {
  try {
    var out = await runSSH(ap, 'wl -i ' + iface + ' assoclist 2>/dev/null');
    return out !== undefined;
  } catch (_) { return false; }
}

async function getInterfacesBroadcom(ap) {
  try {
    var out = await runSSH(ap, "ip -o link show | awk -F': ' '{print $2}' | grep -E '^wl|^eth'");
    var candidates = out.trim().split('\n').map(function(s) { return s.trim(); }).filter(Boolean);
    if (candidates.length === 0) {
      logger.warn('[SSH] ' + ap.name + ' no wl*/eth* interfaces found, using fallback');
      return ['eth4', 'eth5', 'eth6'];
    }
    var results = await Promise.all(candidates.map(async function(iface) {
      var ok = await probeIfaceBroadcom(ap, iface);
      logger.debug('[SSH] ' + ap.name + ' probe ' + iface + ': ' + (ok ? 'ok' : 'skip'));
      return ok ? iface : null;
    }));
    var valid = results.filter(Boolean);
    if (valid.length === 0) {
      logger.warn('[SSH] ' + ap.name + ' no interfaces passed wl probe, using fallback');
      return ['eth4', 'eth5', 'eth6'];
    }
    logger.info('[SSH] ' + ap.name + ' Broadcom interfaces: ' + valid.join(', '));
    return valid;
  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' Broadcom iface discovery failed: ' + err.message);
    return ['eth4', 'eth5', 'eth6'];
  }
}

async function getAssoclistBroadcom(ap, iface) {
  var out = await runSSH(ap, 'wl -i ' + iface + ' assoclist 2>/dev/null || echo ""');
  return out.split('\n')
    .map(function(l) { return l.replace(new RegExp('^assoclist\\s+', 'i'), '').trim().toLowerCase(); })
    .filter(isMac);
}

async function getRssiBroadcom(ap, iface, mac) {
  try {
    var out = await runSSH(ap, 'wl -i ' + iface + ' rssi ' + mac + ' 2>/dev/null || echo ""');
    var m = out.match(new RegExp('-?\\d+'));
    return m ? parseInt(m[0], 10) : null;
  } catch (_) { return null; }
}

/**
 * Fetch per-client TX/RX byte counters via "wl -i <iface> sta_info <mac>".
 * Uses unicast byte counters to avoid inflated totals from mcast/bcast traffic.
 */
async function getStatsBroadcom(ap, iface, mac) {
  try {
    var out = await runSSH(ap, 'wl -i ' + iface + ' sta_info ' + mac + ' 2>/dev/null || echo ""');
    var tx = null;
    var rx = null;
    out.split('\n').forEach(function(line) {
      var l = line.trim().toLowerCase();
      if (l.indexOf('tx ucast bytes') !== -1) {
        var parts = l.split(new RegExp('\\s+'));
        var val = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(val)) tx = val;
      }
      if (l.indexOf('rx ucast bytes') !== -1) {
        var parts2 = l.split(new RegExp('\\s+'));
        var val2 = parseInt(parts2[parts2.length - 1], 10);
        if (!isNaN(val2)) rx = val2;
      }
    });
    return { tx_bytes: tx, rx_bytes: rx };
  } catch (_) { return { tx_bytes: null, rx_bytes: null }; }
}

async function deauthBroadcom(ap, iface, mac) {
  await runSSH(ap, 'wl -i ' + iface + ' deauthenticate ' + mac + ' 2>/dev/null');
}

// ---------------------------------------------------------------------------
// Atheros helpers
// ---------------------------------------------------------------------------
async function getInterfacesAtheros(ap) {
  try {
    var out = await runSSH(ap, "ifconfig 2>/dev/null | grep -E '^ath'");
    var ifaces = out.trim().split('\n')
      .map(function(l) { return l.trim().split(new RegExp('\\s+'))[0]; })
      .filter(Boolean);
    if (ifaces.length > 0) {
      logger.info('[SSH] ' + ap.name + ' Atheros interfaces: ' + ifaces.join(', '));
      return ifaces;
    }
    logger.warn('[SSH] ' + ap.name + ' no ath* interfaces found, using fallback');
    return ['ath0', 'ath1'];
  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' Atheros iface discovery failed: ' + err.message);
    return ['ath0', 'ath1'];
  }
}

function parseWlanconfig(output) {
  var clients = [];
  output.split('\n').forEach(function(line) {
    var parts = line.trim().split(new RegExp('\\s+'));
    if (parts.length < 6) return;
    var mac = parts[0].toLowerCase();
    if (!isMac(mac)) return;
    var rssiRaw = parseInt(parts[5], 10);
    clients.push({ mac: mac, rssi: isNaN(rssiRaw) ? null : rssiRaw });
  });
  return clients;
}

async function getAssoclistAtheros(ap, iface) {
  var out = await runSSH(ap, 'wlanconfig ' + iface + ' list sta 2>/dev/null || echo ""');
  return parseWlanconfig(out);
}

/**
 * Fetch TX/RX byte counters for all stations on an Atheros interface via a
 * single "hostapd_cli -i <iface> all_sta" call.
 * Returns Map<mac, { tx_bytes, rx_bytes }>.
 */
async function getAllStaStatsAtheros(ap, iface) {
  var statsMap = new Map();
  try {
    var out = await runSSH(ap, 'hostapd_cli -i ' + iface + ' all_sta 2>/dev/null || echo ""');
    if (!out || !out.trim()) return statsMap;
    var currentMac = null;
    var tx = null;
    var rx = null;
    function flush() {
      if (currentMac !== null) statsMap.set(currentMac, { tx_bytes: tx, rx_bytes: rx });
    }
    out.split('\n').forEach(function(raw) {
      var line = raw.trim();
      if (!line) return;
      if (isMac(line)) { flush(); currentMac = line.toLowerCase(); tx = null; rx = null; return; }
      if (currentMac === null) return;
      if (line.indexOf('tx_bytes=') === 0) {
        var v = parseInt(line.slice('tx_bytes='.length), 10);
        if (!isNaN(v)) tx = v;
      } else if (line.indexOf('rx_bytes=') === 0) {
        var v2 = parseInt(line.slice('rx_bytes='.length), 10);
        if (!isNaN(v2)) rx = v2;
      }
    });
    flush();
    logger.debug('[SSH] ' + ap.name + ' ' + iface + ' hostapd_cli all_sta: ' + statsMap.size + ' station(s)');
  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' hostapd_cli all_sta on ' + iface + ' failed: ' + err.message);
  }
  return statsMap;
}

async function deauthAtheros(ap, iface, mac) {
  await runSSH(ap, 'wlanconfig ' + iface + ' kick ' + mac + ' 2>/dev/null');
}

module.exports = {
  resolveIfaceCache,
  incrementPollCount,
  getAssoclistBroadcom,
  getRssiBroadcom,
  getStatsBroadcom,
  deauthBroadcom,
  getAssoclistAtheros,
  getAllStaStatsAtheros,
  deauthAtheros,
};
