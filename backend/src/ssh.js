const { Client } = require('ssh2');
const logger = require('./logger');

var MAC_PATTERN = '^([0-9a-f]{2}:){5}[0-9a-f]{2}$';

function isMac(str) {
  return new RegExp(MAC_PATTERN).test(str);
}

function runSSH(ap, command) {
  return new Promise(function(resolve, reject) {
    var conn = new Client();
    var output = '';
    var stderrOut = '';

    logger.debug('[SSH] ' + ap.name + ' CMD: ' + command);

    conn.on('ready', function() {
      logger.debug('[SSH] ' + ap.name + ' connection ready');
      conn.exec(command, function(err, stream) {
        if (err) { conn.end(); return reject(err); }
        stream.on('data', function(data) { output += data.toString(); });
        stream.stderr.on('data', function(data) { stderrOut += data.toString(); });
        stream.on('close', function() {
          if (stderrOut.trim()) logger.debug('[SSH] ' + ap.name + ' stderr: ' + stderrOut.trim());
          conn.end();
          resolve(output);
        });
      });
    });

    conn.on('error', function(err) {
      logger.error('[SSH] ' + ap.name + ' (' + ap.host + ') connection error: ' + err.message);
      reject(err);
    });

    conn.connect({
      host: ap.host,
      port: ap.ssh_port || 22,
      username: ap.username,
      password: ap.password,
      readyTimeout: 10000,
      hostVerifier: function() { return true; },
    });
  });
}

// ---------------------------------------------------------------------------
// Driver detection
// Auto-detects whether the AP uses Broadcom (wl) or Atheros (wlanconfig).
// Result is cached on the ap object to avoid re-probing every poll cycle.
// Can be overridden by setting driver: 'broadcom' or driver: 'atheros' in config.
// ---------------------------------------------------------------------------
async function detectDriver(ap) {
  if (ap._detectedDriver) return ap._detectedDriver;
  if (ap.driver) {
    ap._detectedDriver = ap.driver;
    logger.info('[SSH] ' + ap.name + ' driver: ' + ap.driver + ' (config override)');
    return ap.driver;
  }

  try {
    await runSSH(ap, 'wl ver > /dev/null 2>&1');
    ap._detectedDriver = 'broadcom';
    logger.info('[SSH] ' + ap.name + ' driver: broadcom (auto-detected)');
    return 'broadcom';
  } catch (_) {}

  try {
    await runSSH(ap, 'wlanconfig 2>&1 | head -1 > /dev/null');
    ap._detectedDriver = 'atheros';
    logger.info('[SSH] ' + ap.name + ' driver: atheros (auto-detected)');
    return 'atheros';
  } catch (_) {}

  logger.warn('[SSH] ' + ap.name + ' driver unknown, defaulting to broadcom');
  ap._detectedDriver = 'broadcom';
  return 'broadcom';
}

// ---------------------------------------------------------------------------
// Broadcom interface discovery: ip link + wl probe
// Both wl* and eth* are candidates (master nodes use eth* BSS interfaces).
// Interfaces that fail the wl probe are dropped.
// ---------------------------------------------------------------------------
async function probeIfaceBroadcom(ap, iface) {
  try {
    await runSSH(ap, 'wl -i ' + iface + ' assoclist > /dev/null 2>&1');
    return true;
  } catch (_) {
    return false;
  }
}

async function getWirelessInterfacesBroadcom(ap) {
  try {
    var out = await runSSH(ap, "ip -o link show | awk -F': ' '{print $2}' | grep -E '^wl|^eth'");
    var candidates = out.trim().split(/\n/).map(function(s) { return s.trim(); }).filter(Boolean);

    if (candidates.length === 0) {
      logger.warn('[SSH] ' + ap.name + ' no wl*/eth* interfaces via ip link, using fallback');
      return ['eth4', 'eth5', 'eth6'];
    }

    var probeResults = await Promise.all(candidates.map(async function(iface) {
      var ok = await probeIfaceBroadcom(ap, iface);
      logger.debug('[SSH] ' + ap.name + ' probe ' + iface + ': ' + (ok ? 'ok' : 'skip'));
      return ok ? iface : null;
    }));

    var valid = probeResults.filter(Boolean);
    if (valid.length === 0) {
      logger.warn('[SSH] ' + ap.name + ' no interfaces passed wl probe, using fallback');
      return ['eth4', 'eth5', 'eth6'];
    }

    logger.info('[SSH] ' + ap.name + ' wireless interfaces: ' + valid.join(', '));
    return valid;
  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' interface discovery failed: ' + err.message);
    return ['eth4', 'eth5', 'eth6'];
  }
}

// ---------------------------------------------------------------------------
// Atheros interface discovery: ifconfig | grep ^ath
// ip link does not reliably surface ath* interfaces on stock ASUS firmware.
// ---------------------------------------------------------------------------
async function getWirelessInterfacesAtheros(ap) {
  try {
    var out = await runSSH(ap, "ifconfig 2>/dev/null | grep -E '^ath' | awk '{print $1}'");
    var ifaces = out.trim().split(/\n/).map(function(s) { return s.trim(); }).filter(Boolean);
    if (ifaces.length === 0) {
      logger.warn('[SSH] ' + ap.name + ' no ath* interfaces found, using fallback');
      return ['ath0', 'ath1'];
    }
    logger.info('[SSH] ' + ap.name + ' wireless interfaces: ' + ifaces.join(', '));
    return ifaces;
  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' interface discovery failed: ' + err.message);
    return ['ath0', 'ath1'];
  }
}

async function getWirelessInterfaces(ap, driver) {
  if (driver === 'atheros') return getWirelessInterfacesAtheros(ap);
  return getWirelessInterfacesBroadcom(ap);
}

// ---------------------------------------------------------------------------
// Broadcom client enumeration
// wl assoclist returns one "assoclist <MAC>" per line.
// RSSI is fetched separately (expensive) and used only as a fallback when
// clientlist.json is not available from a master node.
// ---------------------------------------------------------------------------
async function getAssocListBroadcom(ap, iface) {
  var assocOut = await runSSH(ap, 'wl -i ' + iface + ' assoclist 2>/dev/null || echo ""');
  var macs = assocOut
    .split('\n')
    .map(function(l) { return l.replace(/^assoclist\s+/i, '').trim().toLowerCase(); })
    .filter(function(m) { return isMac(m); });
  return macs.map(function(mac) { return { mac: mac, rssi: null }; });
}

async function getRSSIBroadcom(ap, iface, mac) {
  try {
    var rssiOut = await runSSH(ap, 'wl -i ' + iface + ' rssi ' + mac + ' 2>/dev/null || echo ""');
    var m = rssiOut.match(/-?\d+/);
    return m ? parseInt(m[0]) : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Atheros client enumeration
// wlanconfig <iface> list sta returns a table where:
//   column 0 = MAC address (ADDR)
//   column 5 = RSSI (dBm)
// Only lines whose first token is a valid MAC are accepted.
// ---------------------------------------------------------------------------
async function getAssocListAtheros(ap, iface) {
  var out = await runSSH(ap, 'wlanconfig ' + iface + ' list sta 2>/dev/null || echo ""');
  var stations = [];
  out.split('\n').forEach(function(line) {
    var parts = line.trim().split(/\s+/);
    var mac = (parts[0] || '').toLowerCase();
    if (!isMac(mac)) return;
    var rssi = parts[5] ? parseInt(parts[5]) : null;
    stations.push({ mac: mac, rssi: isNaN(rssi) ? null : rssi });
  });
  return stations;
}

// ---------------------------------------------------------------------------
// Master-node data: clientlist.json
// Returns flat map: lowercase-mac -> { ip, rssi }
// Returns null if missing or unparseable (non-master APs won't have this file).
// ---------------------------------------------------------------------------
async function fetchClientlistJson(ap) {
  try {
    var raw = await runSSH(ap, 'cat /tmp/clientlist.json 2>/dev/null');
    if (!raw || !raw.trim()) return null;

    var data = JSON.parse(raw);
    var map = {};

    Object.values(data).forEach(function(apEntry) {
      Object.values(apEntry).forEach(function(bandEntry) {
        if (typeof bandEntry !== 'object' || bandEntry === null) return;
        Object.keys(bandEntry).forEach(function(mac) {
          var info = bandEntry[mac];
          var key = mac.toLowerCase();
          var ip = (info.ip && info.ip !== '') ? info.ip : null;
          var rssi = (info.rssi && info.rssi !== '') ? parseInt(info.rssi, 10) : null;
          if (!map[key]) {
            map[key] = { ip: ip, rssi: isNaN(rssi) ? null : rssi };
          } else {
            if (!map[key].ip && ip) map[key].ip = ip;
            if (map[key].rssi === null && rssi !== null && !isNaN(rssi)) map[key].rssi = rssi;
          }
        });
      });
    });

    logger.info('[SSH] ' + ap.name + ' clientlist.json loaded: ' + Object.keys(map).length + ' client(s)');
    return map;
  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' clientlist.json unavailable: ' + err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Master-node data: aplist.json + relist.json
// Identifies which MACs belong to mesh nodes so they are not shown as
// regular clients or offered a disconnect button in the UI.
// ---------------------------------------------------------------------------
async function fetchMeshNodeMacs(ap) {
  var meshMacs = new Set();

  try {
    var apRaw = await runSSH(ap, 'cat /tmp/aplist.json 2>/dev/null');
    if (apRaw && apRaw.trim()) {
      var apData = JSON.parse(apRaw);
      Object.values(apData).forEach(function(node) {
        Object.values(node).forEach(function(mac) {
          if (mac && mac.includes(':')) meshMacs.add(mac.toLowerCase());
        });
      });
    }
  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' aplist.json unavailable: ' + err.message);
  }

  try {
    var reRaw = await runSSH(ap, 'cat /tmp/relist.json 2>/dev/null');
    if (reRaw && reRaw.trim()) {
      var reData = JSON.parse(reRaw);
      Object.keys(reData).forEach(function(nodeMac) {
        if (nodeMac && nodeMac.includes(':')) meshMacs.add(nodeMac.toLowerCase());
        Object.values(reData[nodeMac]).forEach(function(mac) {
          if (mac && mac.includes(':')) meshMacs.add(mac.toLowerCase());
        });
      });
    }
  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' relist.json unavailable: ' + err.message);
  }

  logger.info('[SSH] ' + ap.name + ' mesh node MACs identified: ' + meshMacs.size);
  return meshMacs;
}

// ---------------------------------------------------------------------------
// Main polling function
// clientlistMap: optional map from fetchClientlistJson (master node)
// meshMacs:      optional Set of mesh-node MAC addresses
// ---------------------------------------------------------------------------
async function fetchClientsFromAP(ap, clientlistMap, meshMacs) {
  var clients = [];
  logger.info('[SSH] Polling AP: ' + ap.name + ' at ' + ap.host + ':' + (ap.ssh_port || 22));

  try {
    var driver = await detectDriver(ap);
    var ifaces = await getWirelessInterfaces(ap, driver);

    // ARP table: MAC -> IP (used when clientlist.json is not available)
    var arpOut = await runSSH(ap, 'cat /proc/net/arp 2>/dev/null || echo ""');
    var arpMacToIp = {};
    arpOut.split('\n').forEach(function(line) {
      var parts = line.trim().split(/\s+/);
      if (parts.length >= 4 && parts[3] && parts[3].includes(':')) {
        arpMacToIp[parts[3].toLowerCase()] = parts[0];
      }
    });
    logger.debug('[SSH] ' + ap.name + ' ARP entries: ' + Object.keys(arpMacToIp).length);

    var seenMacs = new Set();

    for (var i = 0; i < ifaces.length; i++) {
      var iface = ifaces[i];
      try {
        var stations = driver === 'atheros'
          ? await getAssocListAtheros(ap, iface)
          : await getAssocListBroadcom(ap, iface);

        logger.info('[SSH] ' + ap.name + ' iface ' + iface + ': ' + stations.length + ' client(s) associated');

        for (var j = 0; j < stations.length; j++) {
          var mac = stations[j].mac;
          var assocRssi = stations[j].rssi;

          if (seenMacs.has(mac)) {
            logger.debug('[SSH] ' + ap.name + ' skipping duplicate MAC ' + mac + ' on ' + iface);
            continue;
          }
          seenMacs.add(mac);

          var meshNode = meshMacs ? meshMacs.has(mac) : false;

          // IP preference: clientlist.json > ARP table
          var clEntry = clientlistMap ? clientlistMap[mac] : null;
          var ip = (clEntry && clEntry.ip) ? clEntry.ip : (arpMacToIp[mac] || null);

          // RSSI preference: clientlist.json > assoc output > wl rssi (Broadcom fallback only)
          var rssi = (clEntry && clEntry.rssi !== null) ? clEntry.rssi : assocRssi;
          if (rssi === null && driver === 'broadcom') {
            rssi = await getRSSIBroadcom(ap, iface, mac);
            if (rssi !== null) logger.debug('[SSH] ' + ap.name + ' wl rssi fallback for ' + mac + ': ' + rssi);
          }

          clients.push({
            mac: mac,
            ip: ip,
            hostname: null,
            rssi: rssi,
            iface: iface,
            apName: ap.name,
            apHost: ap.host,
            isMeshNode: meshNode,
          });
        }
      } catch (ifaceErr) {
        logger.warn('[SSH] ' + ap.name + ' failed to query iface ' + iface + ': ' + ifaceErr.message);
      }
    }

    logger.info('[SSH] ' + ap.name + ' done: ' + clients.length + ' client(s) total');

  } catch (err) {
    logger.error('[SSH] Fatal error polling ' + ap.name + ': ' + err.message);
  }

  return clients;
}

// ---------------------------------------------------------------------------
// Disconnect / kick a client
// Uses the driver-appropriate command:
//   Broadcom:  wl -i <iface> deauthenticate <mac>
//   Atheros:   wlanconfig <iface> kick <mac>
// Tries all interfaces; returns true if at least one kick succeeded.
// ---------------------------------------------------------------------------
async function disconnectClient(ap, mac) {
  logger.info('[SSH] Kicking client ' + mac + ' from AP ' + ap.name);
  var driver = await detectDriver(ap);
  var ifaces = await getWirelessInterfaces(ap, driver);
  var kicked = false;

  for (var i = 0; i < ifaces.length; i++) {
    var iface = ifaces[i];
    try {
      if (driver === 'atheros') {
        await runSSH(ap, 'wlanconfig ' + iface + ' kick ' + mac + ' 2>/dev/null');
      } else {
        await runSSH(ap, 'wl -i ' + iface + ' deauthenticate ' + mac + ' 2>/dev/null');
      }
      logger.info('[SSH] ' + ap.name + ': deauthenticated ' + mac + ' on ' + iface);
      kicked = true;
    } catch (err) {
      logger.warn('[SSH] ' + ap.name + ': deauth on ' + iface + ' failed: ' + err.message);
    }
  }
  return kicked;
}

module.exports = { fetchClientsFromAP, fetchClientlistJson, fetchMeshNodeMacs, disconnectClient };
