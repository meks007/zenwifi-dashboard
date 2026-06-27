'use strict';

const { Client } = require('ssh2');
const logger = require('./logger');

var MAC_RE = new RegExp('^([0-9a-f]{2}:){5}[0-9a-f]{2}$');

function isMac(str) {
  return MAC_RE.test(str);
}

function runSSH(ap, command) {
  return new Promise(function (resolve, reject) {
    var conn = new Client();
    var output = '';
    var stderrOut = '';
    logger.debug('[SSH] ' + ap.name + ' CMD: ' + command);
    conn.on('ready', function () {
      logger.debug('[SSH] ' + ap.name + ' connection ready');
      conn.exec(command, function (err, stream) {
        if (err) { conn.end(); return reject(err); }
        stream.on('data', function (data) { output += data.toString(); });
        stream.stderr.on('data', function (data) { stderrOut += data.toString(); });
        stream.on('close', function () {
          if (stderrOut.trim()) logger.debug('[SSH] ' + ap.name + ' stderr: ' + stderrOut.trim());
          conn.end();
          resolve(output);
        });
      });
    });
    conn.on('error', function (err) {
      logger.error('[SSH] ' + ap.name + ' (' + ap.host + ') connection error: ' + err.message);
      reject(err);
    });
    conn.connect({
      host: ap.host,
      port: ap.ssh_port || 22,
      username: ap.username,
      password: ap.password,
      readyTimeout: 10000,
      hostVerifier: function () { return true; },
    });
  });
}

// ---------------------------------------------------------------------------
// Interface / driver cache
//
// Keyed by ap.name. Each entry: { driver, ifaces, pollCount }
//
// Discovery (driver detection + interface probing) is expensive: it opens
// several SSH connections per AP before the first assoclist query is even
// issued. Running it on every poll cycle is unnecessary because the set of
// wireless interfaces on an AP almost never changes at runtime.
//
// Strategy:
//   - Run discovery on the very first poll (pollCount === 0).
//   - Re-run every `iface_discovery_interval` polls thereafter.
//   - Use the cached result for all other polls.
//   - On a cache miss (entry absent) always run discovery, so a restart
//     or a newly added AP is handled correctly.
//   - disconnectClient() uses the cache as-is (warm after the first poll)
//     and falls back to live discovery only if the cache is cold, so it
//     never triggers a redundant rediscovery cycle.
// ---------------------------------------------------------------------------

var ifaceCache = {}; // ap.name -> { driver, ifaces, pollCount }

// Default: re-run discovery every 10 polls (~5 min at 30s interval).
var DEFAULT_IFACE_DISCOVERY_INTERVAL = 10;

/**
 * Returns the cached { driver, ifaces } for an AP, running (or re-running)
 * discovery when needed.
 *
 * @param {object} ap       - AP config entry
 * @param {number} interval - Re-run discovery every N polls (0 = always)
 */
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
    ifaceCache[ap.name] = {
      driver:    driver,
      ifaces:    ifaces,
      pollCount: entry ? entry.pollCount : 0,
    };
  } else {
    logger.debug(
      '[SSH] ' + ap.name + ' using cached interfaces [' +
      entry.ifaces.join(', ') + '] (cycle ' + entry.pollCount + ')'
    );
  }

  return ifaceCache[ap.name];
}

/**
 * Increment the poll counter for an AP after a completed poll cycle.
 * Called at the end of fetchClientsFromAP regardless of success/failure.
 */
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
  } catch (_) {
    return false;
  }
}

async function getInterfacesBroadcom(ap) {
  try {
    var out = await runSSH(ap, "ip -o link show | awk -F': ' '{print $2}' | grep -E '^wl|^eth'");
    var candidates = out.trim().split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    if (candidates.length === 0) {
      logger.warn('[SSH] ' + ap.name + ' no wl*/eth* interfaces found, using fallback');
      return ['eth4', 'eth5', 'eth6'];
    }
    var results = await Promise.all(candidates.map(async function (iface) {
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
    .map(function (l) { return l.replace(new RegExp('^assoclist\\s+', 'i'), '').trim().toLowerCase(); })
    .filter(isMac);
}

async function getRssiBroadcom(ap, iface, mac) {
  try {
    var out = await runSSH(ap, 'wl -i ' + iface + ' rssi ' + mac + ' 2>/dev/null || echo ""');
    var m = out.match(new RegExp('-?\\d+'));
    return m ? parseInt(m[0], 10) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Fetch per-client TX/RX byte counters via "wl -i <iface> sta_info <mac>".
 * Uses unicast byte counters to avoid inflated totals from mcast/bcast traffic.
 *
 * Relevant lines in sta_info output:
 *   tx ucast bytes         827053914
 *   rx ucast bytes         1028377000
 */
async function getStatsBroadcom(ap, iface, mac) {
  try {
    var out = await runSSH(ap, 'wl -i ' + iface + ' sta_info ' + mac + ' 2>/dev/null || echo ""');
    var tx = null;
    var rx = null;
    out.split('\n').forEach(function (line) {
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
  } catch (_) {
    return { tx_bytes: null, rx_bytes: null };
  }
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
      .map(function (l) { return l.trim().split(new RegExp('\\s+'))[0]; })
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
  output.split('\n').forEach(function (line) {
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
 *
 * The output has no blank lines between fields. Each station block starts
 * with a bare MAC address line, followed by key=value lines. The next MAC
 * line signals the start of the next block:
 *
 *   24:18:c6:12:f5:9c
 *   flags=[AUTH][ASSOC][AUTHORIZED]
 *   rx_bytes=18871829
 *   tx_bytes=2003986
 *   ...
 *   90:11:95:f9:78:74
 *   ...
 *
 * Returns Map<lowercase-mac, { tx_bytes, rx_bytes }>.
 * Returns an empty Map if hostapd_cli is unavailable or produces no output.
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
      if (currentMac !== null) {
        statsMap.set(currentMac, { tx_bytes: tx, rx_bytes: rx });
      }
    }

    out.split('\n').forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      if (isMac(line)) {
        flush();
        currentMac = line.toLowerCase();
        tx = null;
        rx = null;
        return;
      }
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

// ---------------------------------------------------------------------------
// Master node helpers (XT8 AiMesh)
// ---------------------------------------------------------------------------

async function fetchClientlistJson(ap) {
  try {
    var raw = await runSSH(ap, 'cat /tmp/clientlist.json 2>/dev/null');
    if (!raw || !raw.trim()) return null;
    var data = JSON.parse(raw);
    var map = {};
    Object.values(data).forEach(function (apEntry) {
      Object.values(apEntry).forEach(function (bandEntry) {
        if (typeof bandEntry !== 'object' || bandEntry === null) return;
        Object.keys(bandEntry).forEach(function (mac) {
          var info = bandEntry[mac];
          var key = mac.toLowerCase();
          var ip = (info.ip && info.ip !== '') ? info.ip : null;
          var rssiRaw = parseInt(info.rssi, 10);
          var rssi = isNaN(rssiRaw) ? null : rssiRaw;
          if (!map[key]) {
            map[key] = { ip: ip, rssi: rssi };
          } else {
            if (!map[key].ip && ip) map[key].ip = ip;
            if (map[key].rssi === null && rssi !== null) map[key].rssi = rssi;
          }
        });
      });
    });
    logger.info('[SSH] ' + ap.name + ' clientlist.json: ' + Object.keys(map).length + ' client(s)');
    return map;
  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' clientlist.json unavailable: ' + err.message);
    return null;
  }
}

/**
 * Fetch ip neigh show from the master node and return a plain object
 * mapping lowercase MAC -> IP for REACHABLE entries only.
 *
 * This must be called on the master because the master has authoritative
 * REACHABLE entries for all mesh node management IPs. Satellite nodes only
 * see their own local subnet and may resolve the wrong IP for other nodes.
 */
async function fetchNeighMap(ap) {
  try {
    var neighOut = await runSSH(ap, 'ip neigh show 2>/dev/null || echo ""');
    var neighMacToIp = {};
    neighOut.split('\n').forEach(function (line) {
      var parts = line.trim().split(new RegExp('\\s+'));
      var macIdx = parts.indexOf('lladdr') + 1;
      if (macIdx > 0 && macIdx < parts.length) {
        var state = parts[parts.length - 1].toUpperCase();
        if (state === 'REACHABLE') {
          neighMacToIp[parts[macIdx].toLowerCase()] = parts[0];
        }
      }
    });
    logger.info('[SSH] ' + ap.name + ' REACHABLE neigh entries: ' + Object.keys(neighMacToIp).length);
    return neighMacToIp;
  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' ip neigh show unavailable: ' + err.message);
    return {};
  }
}

/**
 * Read /tmp/aplist.json and /tmp/relist.json from the master node and
 * return a Map<lowercase-mac, nodeId> covering every MAC that belongs to
 * a mesh node (satellites and master alike), plus the raw nodeGroups map.
 *
 * Two-step strategy:
 *
 * Step 1 - relist.json is authoritative for satellites.
 *   Each top-level key is the primary backhaul MAC of one satellite (nodeId).
 *   Its value object contains the sta MACs the master sees that satellite on.
 *   All MACs are added to a nodeGroups map keyed by nodeId.
 *
 * Step 2 - aplist.json adds client-facing BSSIDs.
 *   aplist node 0 is the master; its BSSIDs get their own provisional nodeId.
 *   For every other aplist node, scan its BSSIDs against the already-known
 *   MACs in nodeGroups (both primary keys and sta MACs). The first match
 *   identifies which satellite nodeId this aplist node belongs to, and all
 *   BSSIDs are merged into that group. This handles the common case where
 *   the relist primary key and the aplist BSSID differ by one bit.
 *
 * Returns { meshMap, nodeGroups } where:
 *   meshMap    - flat Map<mac, nodeId> for O(1) lookups
 *   nodeGroups - Map<nodeId, Set<mac>> preserving all MACs per node,
 *                used by resolveNeighIp() to find the IP via any backhaul
 *                STA MAC when the primary/AP MAC is absent from the neigh table.
 */
async function fetchMeshNodeMacs(ap) {
  var nodeGroups = new Map();

  function ensureGroup(nodeId) {
    if (!nodeGroups.has(nodeId)) nodeGroups.set(nodeId, new Set());
  }
  function addToGroup(nodeId, mac) {
    var id = nodeId.toLowerCase();
    var m = mac.toLowerCase();
    ensureGroup(id);
    nodeGroups.get(id).add(m);
  }
  function macToNodeId(mac) {
    var m = mac.toLowerCase();
    var found = null;
    nodeGroups.forEach(function (macs, nodeId) {
      if (macs.has(m)) found = nodeId;
    });
    return found;
  }

  // Step 1: build satellite node groups from relist.json
  // relist.json primary keys arrive from the router in uppercase; normalise to
  // lowercase before calling isMac() to avoid silently dropping satellites.
  try {
    var reRaw = await runSSH(ap, 'cat /tmp/relist.json 2>/dev/null');
    if (reRaw && reRaw.trim()) {
      var reData = JSON.parse(reRaw);
      Object.keys(reData).forEach(function (primaryMac) {
        var primaryMacLower = primaryMac.toLowerCase();
        if (!isMac(primaryMacLower)) return;
        var nodeId = primaryMacLower;
        addToGroup(nodeId, primaryMacLower);
        Object.values(reData[primaryMac]).forEach(function (mac) {
          if (mac) {
            var macLower = mac.toLowerCase();
            if (isMac(macLower)) addToGroup(nodeId, macLower);
          }
        });
      });
      logger.info('[SSH] ' + ap.name + ' relist.json: ' + nodeGroups.size + ' satellite(s)');
    }
  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' relist.json unavailable: ' + err.message);
  }

  // Step 2: join aplist.json BSSIDs into the correct node groups
  try {
    var apRaw = await runSSH(ap, 'cat /tmp/aplist.json 2>/dev/null');
    if (apRaw && apRaw.trim()) {
      var apData = JSON.parse(apRaw);
      var nodeKeys = Object.keys(apData).sort(function (a, b) { return parseInt(a) - parseInt(b); });
      nodeKeys.forEach(function (nodeIndex) {
        var node = apData[nodeIndex];
        var bssids = Object.values(node)
          .filter(function (m) { return m && isMac(m.toLowerCase()); })
          .map(function (m) { return m.toLowerCase(); });
        if (bssids.length === 0) return;
        if (nodeIndex === '0') {
          var masterId = bssids[0];
          bssids.forEach(function (b) { addToGroup(masterId, b); });
          return;
        }
        var matchedNodeId = null;
        for (var i = 0; i < bssids.length; i++) {
          var hit = macToNodeId(bssids[i]);
          if (hit) { matchedNodeId = hit; break; }
        }
        if (matchedNodeId) {
          bssids.forEach(function (b) { addToGroup(matchedNodeId, b); });
        } else {
          var provId = bssids[0];
          bssids.forEach(function (b) { addToGroup(provId, b); });
          logger.warn('[SSH] ' + ap.name + ' aplist node ' + nodeIndex + ' has no relist match, provisional nodeId ' + provId);
        }
      });
      logger.info('[SSH] ' + ap.name + ' aplist.json: ' + nodeKeys.length + ' node(s) processed');
    }
  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' aplist.json unavailable: ' + err.message);
  }

  var meshMap = new Map();
  nodeGroups.forEach(function (macs, nodeId) {
    macs.forEach(function (mac) { meshMap.set(mac, nodeId); });
  });

  var nodeCount = new Set(meshMap.values()).size;
  logger.info('[SSH] ' + ap.name + ' mesh MACs mapped: ' + meshMap.size + ' MAC(s) across ' + nodeCount + ' node(s)');
  return { meshMap: meshMap, nodeGroups: nodeGroups };
}

// ---------------------------------------------------------------------------
// fetchClientsFromAP
// ---------------------------------------------------------------------------

/**
 * Fetch all wireless clients from an AP.
 *
 * @param {object}      ap                      AP config entry
 * @param {object|null} clientlistMap            flat MAC->{ip,rssi} from master (or null)
 * @param {Map|null}    meshMap                  Map<mac,nodeId> from fetchMeshNodeMacs (or null)
 * @param {object}      neighMacToIp             MAC->IP from fetchNeighMap on master (or {})
 * @param {Map|null}    nodeGroups               nodeId -> Set<mac> from fetchMeshNodeMacs (or null)
 * @param {number}      ifaceDiscoveryInterval   Re-run interface discovery every N polls (default 10)
 * @returns {Array} client objects
 */
async function fetchClientsFromAP(ap, clientlistMap, meshMap, neighMacToIp, nodeGroups, ifaceDiscoveryInterval) {
  var clients = [];
  var neigh = neighMacToIp || {};

  /**
   * Resolve the management IP for a mesh node by checking every MAC in its
   * node group against the neigh table. The primary/AP MAC (e.g. a8:5e:45:fe:ae:fc)
   * is often absent from ip-neigh because the router only sees the backhaul STA
   * MAC (e.g. ae:5e:45:fe:ae:fe) at L2. Walking the whole group finds the right IP.
   */
  function resolveNeighIp(nodeId) {
    if (neigh[nodeId]) return neigh[nodeId];
    if (!nodeGroups) return null;
    var group = nodeGroups.get(nodeId);
    if (!group) return null;
    var found = null;
    group.forEach(function (groupMac) {
      if (!found && neigh[groupMac]) found = neigh[groupMac];
    });
    return found;
  }

  logger.info('[SSH] Polling AP: ' + ap.name + ' (' + ap.host + ':' + (ap.ssh_port || 22) + ')');

  try {
    // Resolve driver + interfaces from cache, running discovery only when due.
    var cached = await resolveIfaceCache(ap, ifaceDiscoveryInterval);
    var driver = cached.driver;

    // /proc/net/arp: used for regular client IP resolution only.
    // Stale entries are acceptable for sleeping devices.
    var arpOut = await runSSH(ap, 'cat /proc/net/arp 2>/dev/null || echo ""');
    var arpMacToIp = {};
    arpOut.split('\n').forEach(function (line) {
      var parts = line.trim().split(new RegExp('\\s+'));
      if (parts.length >= 4 && parts[3] && parts[3].includes(':')) {
        arpMacToIp[parts[3].toLowerCase()] = parts[0];
      }
    });
    logger.debug('[SSH] ' + ap.name + ' ARP entries: ' + Object.keys(arpMacToIp).length);

    var seenMacs = new Set();

    if (driver === 'atheros') {
      var athIfaces = cached.ifaces;
      for (var ai = 0; ai < athIfaces.length; ai++) {
        var athIface = athIfaces[ai];
        try {
          var stations = await getAssoclistAtheros(ap, athIface);
          logger.info('[SSH] ' + ap.name + ' iface ' + athIface + ': ' + stations.length + ' client(s)');

          var statsMap = await getAllStaStatsAtheros(ap, athIface);
          for (var si = 0; si < stations.length; si++) {
            var staMac = stations[si].mac;
            var staRssi = stations[si].rssi;
            if (seenMacs.has(staMac)) continue;
            seenMacs.add(staMac);
            var meshNodeId = meshMap ? (meshMap.get(staMac) || null) : null;
            var clEntry = clientlistMap ? clientlistMap[staMac] : null;
            var ip = (clEntry && clEntry.ip) ? clEntry.ip
              : (meshNodeId !== null ? resolveNeighIp(meshNodeId) : (arpMacToIp[staMac] || null));
            var rssi = (clEntry && clEntry.rssi !== null) ? clEntry.rssi : staRssi;
            var stats = statsMap.get(staMac) || { tx_bytes: null, rx_bytes: null };
            clients.push({
              mac: staMac, ip: ip, hostname: null, rssi: rssi,
              iface: athIface, apName: ap.name, apHost: ap.host,
              isMeshNode: meshNodeId !== null, meshNodeId: meshNodeId,
              tx_bytes: stats.tx_bytes, rx_bytes: stats.rx_bytes,
            });
          }
        } catch (ifaceErr) {
          logger.warn('[SSH] ' + ap.name + ' failed to query ' + athIface + ': ' + ifaceErr.message);
        }
      }
    } else {
      var bcIfaces = cached.ifaces;
      for (var bi = 0; bi < bcIfaces.length; bi++) {
        var bcIface = bcIfaces[bi];
        try {
          var macs = await getAssoclistBroadcom(ap, bcIface);
          logger.info('[SSH] ' + ap.name + ' iface ' + bcIface + ': ' + macs.length + ' client(s)');
          for (var mi = 0; mi < macs.length; mi++) {
            var mac = macs[mi];
            if (seenMacs.has(mac)) continue;
            seenMacs.add(mac);
            var meshId = meshMap ? (meshMap.get(mac) || null) : null;
            var clE = clientlistMap ? clientlistMap[mac] : null;
            var macIp = (clE && clE.ip) ? clE.ip
              : (meshId !== null ? resolveNeighIp(meshId) : (arpMacToIp[mac] || null));
            var macRssi = (clE && clE.rssi !== null) ? clE.rssi : null;
            if (macRssi === null) {
              macRssi = await getRssiBroadcom(ap, bcIface, mac);
              if (macRssi !== null) {
                logger.debug('[SSH] ' + ap.name + ' wl rssi fallback for ' + mac + ': ' + macRssi);
              }
            }
            var bcStats = await getStatsBroadcom(ap, bcIface, mac);
            clients.push({
              mac: mac, ip: macIp, hostname: null, rssi: macRssi,
              iface: bcIface, apName: ap.name, apHost: ap.host,
              isMeshNode: meshId !== null, meshNodeId: meshId,
              tx_bytes: bcStats.tx_bytes, rx_bytes: bcStats.rx_bytes,
            });
          }
        } catch (ifaceErr) {
          logger.warn('[SSH] ' + ap.name + ' failed to query ' + bcIface + ': ' + ifaceErr.message);
        }
      }
    }

    logger.info('[SSH] ' + ap.name + ' done: ' + clients.length + ' client(s) total');
  } catch (err) {
    logger.error('[SSH] Fatal error polling ' + ap.name + ': ' + err.message);
  }

  // Always advance the counter so the interval tracks real poll attempts.
  incrementPollCount(ap);

  return clients;
}

// ---------------------------------------------------------------------------
// disconnectClient
// ---------------------------------------------------------------------------

async function disconnectClient(ap, mac) {
  logger.info('[SSH] Kicking client ' + mac + ' from AP ' + ap.name);

  // Use the warm cache if available. If the cache is cold (e.g. called before
  // the first poll cycle), fall back to live discovery with interval=1 so we
  // do not leave the cache empty for the next regular poll.
  var cached = await resolveIfaceCache(ap, ifaceCache[ap.name] ? Infinity : 1);
  var driver = cached.driver;
  var kicked = false;

  if (driver === 'atheros') {
    var athIfaces = cached.ifaces;
    for (var ai = 0; ai < athIfaces.length; ai++) {
      try {
        await deauthAtheros(ap, athIfaces[ai], mac);
        logger.info('[SSH] ' + ap.name + ': kicked ' + mac + ' on ' + athIfaces[ai]);
        kicked = true;
      } catch (err) {
        logger.warn('[SSH] ' + ap.name + ': kick on ' + athIfaces[ai] + ' failed: ' + err.message);
      }
    }
  } else {
    var bcIfaces = cached.ifaces;
    for (var bi = 0; bi < bcIfaces.length; bi++) {
      try {
        await deauthBroadcom(ap, bcIfaces[bi], mac);
        logger.info('[SSH] ' + ap.name + ': deauthenticated ' + mac + ' on ' + bcIfaces[bi]);
        kicked = true;
      } catch (err) {
        logger.warn('[SSH] ' + ap.name + ': deauth on ' + bcIfaces[bi] + ' failed: ' + err.message);
      }
    }
  }

  return kicked;
}

module.exports = { fetchClientsFromAP, fetchClientlistJson, fetchMeshNodeMacs, fetchNeighMap, disconnectClient };
