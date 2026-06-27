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
 * Fetch per-client TX/RX byte counters for Atheros via hostapd_cli.
 *
 * "hostapd_cli -i <iface> all_sta" returns one block per client separated
 * by blank lines. Each block starts with the client MAC on its own line,
 * followed by key=value pairs including rx_bytes and tx_bytes.
 *
 * Returns nulls if hostapd_cli is unavailable or the MAC is not found.
 */
async function getStatsAtheros(ap, iface, mac) {
  try {
    var out = await runSSH(ap, 'hostapd_cli -i ' + iface + ' all_sta 2>/dev/null || echo ""');
    var tx = null;
    var rx = null;
    var blocks = out.split('\n\n');
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i].trim();
      if (!block) continue;
      var lines = block.split('\n');
      if (lines[0].trim().toLowerCase() !== mac) continue;
      for (var j = 1; j < lines.length; j++) {
        var line = lines[j].trim();
        if (line.indexOf('tx_bytes=') === 0) {
          var val = parseInt(line.split('=')[1], 10);
          if (!isNaN(val)) tx = val;
        }
        if (line.indexOf('rx_bytes=') === 0) {
          var val2 = parseInt(line.split('=')[1], 10);
          if (!isNaN(val2)) rx = val2;
        }
      }
      break;
    }
    return { tx_bytes: tx, rx_bytes: rx };
  } catch (_) {
    return { tx_bytes: null, rx_bytes: null };
  }
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
 * Read /tmp/aplist.json and /tmp/relist.json from the master node.
 *
 * Returns Map<lowercase-mac, nodeId> where nodeId is the lowercase primary
 * AP MAC (the key in relist.json). Every AP BSSID and every backhaul STA MAC
 * belonging to the same physical node maps to the same nodeId.
 */
async function fetchMeshNodeMacs(ap) {
  var meshMap = new Map();

  function addNodeMacs(nodeId, macs) {
    var id = nodeId.toLowerCase();
    macs.forEach(function (mac) {
      if (mac && mac.includes(':')) meshMap.set(mac.toLowerCase(), id);
    });
  }

  try {
    var apRaw = await runSSH(ap, 'cat /tmp/aplist.json 2>/dev/null');
    if (apRaw && apRaw.trim()) {
      var apData = JSON.parse(apRaw);
      Object.values(apData).forEach(function (node) {
        var bssids = Object.values(node).filter(function (m) { return m && m.includes(':'); });
        if (bssids.length === 0) return;
        var provisionalId = bssids[0].toLowerCase();
        addNodeMacs(provisionalId, bssids);
      });
    }
  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' aplist.json unavailable: ' + err.message);
  }

  try {
    var reRaw = await runSSH(ap, 'cat /tmp/relist.json 2>/dev/null');
    if (reRaw && reRaw.trim()) {
      var reData = JSON.parse(reRaw);
      Object.keys(reData).forEach(function (primaryMac) {
        if (!primaryMac || !primaryMac.includes(':')) return;
        var nodeId = primaryMac.toLowerCase();
        var staMacs = Object.values(reData[primaryMac]).filter(function (m) { return m && m.includes(':'); });
        meshMap.set(nodeId, nodeId);
        staMacs.forEach(function (mac) { meshMap.set(mac.toLowerCase(), nodeId); });
      });
    }
  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' relist.json unavailable: ' + err.message);
  }

  var nodeCount = new Set(meshMap.values()).size;
  logger.info('[SSH] ' + ap.name + ' mesh MACs mapped: ' + meshMap.size + ' MAC(s) across ' + nodeCount + ' node(s)');
  return meshMap;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all wireless clients from an AP.
 *
 * @param {object}      ap            AP config entry
 * @param {object|null} clientlistMap flat MAC->{ip,rssi} from master (or null)
 * @param {Map|null}    meshMap       Map<mac,nodeId> from fetchMeshNodeMacs (or null)
 * @returns {Array} client objects
 */
async function fetchClientsFromAP(ap, clientlistMap, meshMap) {
  var clients = [];
  logger.info('[SSH] Polling AP: ' + ap.name + ' (' + ap.host + ':' + (ap.ssh_port || 22) + ')');

  try {
    var driver = await detectDriver(ap);

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
      var athIfaces = await getInterfacesAtheros(ap);
      for (var ai = 0; ai < athIfaces.length; ai++) {
        var athIface = athIfaces[ai];
        try {
          var stations = await getAssoclistAtheros(ap, athIface);
          logger.info('[SSH] ' + ap.name + ' iface ' + athIface + ': ' + stations.length + ' client(s)');
          for (var si = 0; si < stations.length; si++) {
            var staMac = stations[si].mac;
            var staRssi = stations[si].rssi;
            if (seenMacs.has(staMac)) continue;
            seenMacs.add(staMac);
            var meshNodeId = meshMap ? (meshMap.get(staMac) || null) : null;
            var clEntry = clientlistMap ? clientlistMap[staMac] : null;
            var ip = (clEntry && clEntry.ip) ? clEntry.ip : (arpMacToIp[staMac] || null);
            var rssi = (clEntry && clEntry.rssi !== null) ? clEntry.rssi : staRssi;
            var stats = await getStatsAtheros(ap, athIface, staMac);
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
      var bcIfaces = await getInterfacesBroadcom(ap);
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
            var macIp = (clE && clE.ip) ? clE.ip : (arpMacToIp[mac] || null);
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

  return clients;
}

async function disconnectClient(ap, mac) {
  logger.info('[SSH] Kicking client ' + mac + ' from AP ' + ap.name);
  var driver = await detectDriver(ap);
  var kicked = false;
  if (driver === 'atheros') {
    var athIfaces = await getInterfacesAtheros(ap);
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
    var bcIfaces = await getInterfacesBroadcom(ap);
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

module.exports = { fetchClientsFromAP, fetchClientlistJson, fetchMeshNodeMacs, disconnectClient };
