const { Client } = require('ssh2');
const logger = require('./logger');

function runSSH(ap, command) {
  return new Promise(function(resolve, reject) {
    const conn = new Client();
    let output = '';
    let stderrOut = '';

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

// Probe a single interface: returns true if wl considers it a valid wireless BSS.
async function probeIface(ap, iface) {
  try {
    await runSSH(ap, 'wl -i ' + iface + ' assoclist > /dev/null 2>&1');
    return true;
  } catch (_) {
    return false;
  }
}

// Discover wireless interfaces via ip link, validate each with a wl probe.
// Both wl* and eth* are candidates:
//   - Mesh slave nodes expose clients on wl* interfaces
//   - Mesh master nodes expose clients on eth* interfaces (eth4/5/6 on XT8)
// Interfaces that fail the wl probe (eth0-eth3, switch ports) are dropped.
async function getWirelessInterfaces(ap) {
  try {
    const out = await runSSH(
      ap,
      "ip -o link show | awk -F': ' '{print $2}' | grep -E '^wl|^eth'"
    );
    const candidates = out.trim().split(/\n/).map(function(s) { return s.trim(); }).filter(Boolean);

    if (candidates.length === 0) {
      logger.warn('[SSH] ' + ap.name + ' no wl*/eth* interfaces found via ip link, using fallback [eth4, eth5, eth6]');
      return ['eth4', 'eth5', 'eth6'];
    }

    const probeResults = await Promise.all(candidates.map(async function(iface) {
      const ok = await probeIface(ap, iface);
      logger.debug('[SSH] ' + ap.name + ' probe ' + iface + ': ' + (ok ? 'ok' : 'skip'));
      return ok ? iface : null;
    }));

    const valid = probeResults.filter(Boolean);

    if (valid.length === 0) {
      logger.warn('[SSH] ' + ap.name + ' no interfaces passed wl probe, using fallback [eth4, eth5, eth6]');
      return ['eth4', 'eth5', 'eth6'];
    }

    logger.info('[SSH] ' + ap.name + ' wireless interfaces: ' + valid.join(', '));
    return valid;

  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' interface discovery failed (' + err.message + '), using fallback [eth4, eth5, eth6]');
    return ['eth4', 'eth5', 'eth6'];
  }
}

// Read /tmp/clientlist.json from the master node.
// Returns a flat map: lowercase-mac -> { ip, rssi } for every client the
// master knows about across all APs and bands.
// Returns null if the file is missing or cannot be parsed.
async function fetchClientlistJson(ap) {
  try {
    const raw = await runSSH(ap, 'cat /tmp/clientlist.json 2>/dev/null');
    if (!raw || !raw.trim()) return null;

    const data = JSON.parse(raw);
    const map = {};

    // Structure: { "<AP-MAC>": { "2G": { "<client-MAC>": { ip, rssi } }, "5G": ..., "wired_mac": ... } }
    Object.values(data).forEach(function(apEntry) {
      Object.values(apEntry).forEach(function(bandEntry) {
        if (typeof bandEntry !== 'object' || bandEntry === null) return;
        Object.keys(bandEntry).forEach(function(mac) {
          const info = bandEntry[mac];
          const key = mac.toLowerCase();
          const ip = (info.ip && info.ip !== '') ? info.ip : null;
          const rssi = (info.rssi && info.rssi !== '') ? parseInt(info.rssi, 10) : null;
          if (!map[key]) {
            map[key] = { ip: ip, rssi: isNaN(rssi) ? null : rssi };
          } else {
            if (!map[key].ip && ip) map[key].ip = ip;
            if (map[key].rssi === null && rssi !== null && !isNaN(rssi)) map[key].rssi = rssi;
          }
        });
      });
    });

    const total = Object.keys(map).length;
    logger.info('[SSH] ' + ap.name + ' clientlist.json loaded: ' + total + ' client(s)');
    return map;

  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' clientlist.json unavailable: ' + err.message);
    return null;
  }
}

// Read /tmp/aplist.json and /tmp/relist.json from the master node.
// Returns a Set of lowercase MACs that belong to AiMesh infrastructure
// (node radio BSSIDs and backhaul STA MACs).
async function fetchMeshNodeMacs(ap) {
  const meshMacs = new Set();

  try {
    const apRaw = await runSSH(ap, 'cat /tmp/aplist.json 2>/dev/null');
    if (apRaw && apRaw.trim()) {
      const apData = JSON.parse(apRaw);
      // { "0": { "ap2g": "MAC", "ap5g": "MAC", ... }, ... }
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
    const reRaw = await runSSH(ap, 'cat /tmp/relist.json 2>/dev/null');
    if (reRaw && reRaw.trim()) {
      const reData = JSON.parse(reRaw);
      // { "<node-MAC>": { "sta2g": "MAC", "sta5g": "MAC", ... }, ... }
      Object.keys(reData).forEach(function(nodeMac) {
        if (nodeMac && nodeMac.includes(':')) meshMacs.add(nodeMac.toLowerCase());
        const stas = reData[nodeMac];
        Object.values(stas).forEach(function(mac) {
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

// fetchClientsFromAP accepts an optional clientlistMap (from the master node)
// used as the primary source for IP and RSSI, and an optional meshMacs Set
// used to mark mesh infrastructure nodes.
// Falls back to ARP for IP and wl rssi for RSSI when clientlist is non-conclusive.
async function fetchClientsFromAP(ap, clientlistMap, meshMacs) {
  const clients = [];
  logger.info('[SSH] Polling AP: ' + ap.name + ' at ' + ap.host + ':' + (ap.ssh_port || 22));

  try {
    const ifaces = await getWirelessInterfaces(ap);

    // ARP table as IP fallback
    const arpOut = await runSSH(ap, 'cat /proc/net/arp 2>/dev/null || echo ""');
    const arpMacToIp = {};
    arpOut.split('\n').forEach(function(line) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4 && parts[3] && parts[3].includes(':')) {
        arpMacToIp[parts[3].toLowerCase()] = parts[0];
      }
    });
    logger.debug('[SSH] ' + ap.name + ' ARP entries: ' + Object.keys(arpMacToIp).length);

    const seenMacs = new Set();

    for (let i = 0; i < ifaces.length; i++) {
      const iface = ifaces[i];
      try {
        const assocOut = await runSSH(ap, 'wl -i ' + iface + ' assoclist 2>/dev/null || echo ""');
        const macs = assocOut
          .split('\n')
          .map(function(l) { return l.replace(/^assoclist\s+/i, '').trim().toLowerCase(); })
          .filter(function(m) { return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m); });
        logger.info('[SSH] ' + ap.name + ' iface ' + iface + ': ' + macs.length + ' client(s) associated');

        for (let j = 0; j < macs.length; j++) {
          const mac = macs[j];

          if (seenMacs.has(mac)) {
            logger.debug('[SSH] ' + ap.name + ' skipping duplicate MAC ' + mac + ' on ' + iface);
            continue;
          }
          seenMacs.add(mac);

          const isMeshNode = meshMacs ? meshMacs.has(mac) : false;

          // Resolve IP: clientlist first, ARP fallback
          const clEntry = clientlistMap ? clientlistMap[mac] : null;
          const ip = (clEntry && clEntry.ip) ? clEntry.ip : (arpMacToIp[mac] || null);

          // Resolve RSSI: clientlist first, wl rssi fallback only when needed
          let rssi = (clEntry && clEntry.rssi !== null) ? clEntry.rssi : null;
          if (rssi === null) {
            try {
              const rssiOut = await runSSH(ap, 'wl -i ' + iface + ' rssi ' + mac + ' 2>/dev/null || echo ""');
              const rssiMatch = rssiOut.match(/-?\d+/);
              if (rssiMatch) rssi = parseInt(rssiMatch[0]);
              logger.debug('[SSH] ' + ap.name + ' wl rssi fallback for ' + mac + ': ' + rssi);
            } catch (rssiErr) {
              logger.debug('[SSH] ' + ap.name + ' RSSI unavailable for ' + mac + ': ' + rssiErr.message);
            }
          }

          clients.push({
            mac: mac,
            ip: ip,
            hostname: null,
            rssi: rssi,
            iface: iface,
            apName: ap.name,
            apHost: ap.host,
            isMeshNode: isMeshNode,
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

async function disconnectClient(ap, mac) {
  logger.info('[SSH] Kicking client ' + mac + ' from AP ' + ap.name);
  const ifaces = await getWirelessInterfaces(ap);
  let kicked = false;
  for (let i = 0; i < ifaces.length; i++) {
    const iface = ifaces[i];
    try {
      await runSSH(ap, 'wl -i ' + iface + ' deauthenticate ' + mac + ' 2>/dev/null');
      logger.info('[SSH] ' + ap.name + ': deauthenticated ' + mac + ' on ' + iface);
      kicked = true;
    } catch (err) {
      logger.warn('[SSH] ' + ap.name + ': deauth on ' + iface + ' failed: ' + err.message);
    }
  }
  return kicked;
}

module.exports = { fetchClientsFromAP, fetchClientlistJson, fetchMeshNodeMacs, disconnectClient };
