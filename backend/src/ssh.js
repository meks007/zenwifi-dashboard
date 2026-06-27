'use strict';

const { Client } = require('ssh2');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAC_PATTERN = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

function isMac(str) {
  return MAC_PATTERN.test(str);
}

/**
 * Run a single command on an AP over SSH and return stdout as a string.
 */
function runSSH(ap, command) {
  return new Promise(function (resolve, reject) {
    const conn = new Client();
    let output = '';
    let stderrOut = '';

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

/**
 * Detect the wireless driver on an AP.
 * Returns 'broadcom', 'atheros', or throws if neither is found.
 *
 * The ap.driver config key overrides auto-detection:
 *   driver: broadcom   -> always use wl
 *   driver: atheros    -> always use wlanconfig
 */
async function detectDriver(ap) {
  // Config override takes priority
  if (ap.driver) {
    const d = ap.driver.toLowerCase();
    if (d === 'broadcom' || d === 'atheros') {
      logger.info('[SSH] ' + ap.name + ' driver override: ' + d);
      return d;
    }
    logger.warn('[SSH] ' + ap.name + ' unknown driver override "' + ap.driver + '", falling back to auto-detect');
  }

  // Try Broadcom wl first
  try {
    const out = await runSSH(ap, 'wl ver 2>/dev/null');
    if (out && out.trim().length > 0) {
      logger.info('[SSH] ' + ap.name + ' driver detected: broadcom (wl ver succeeded)');
      return 'broadcom';
    }
  } catch (_) { /* fall through */ }

  // Try Atheros/Qualcomm wlanconfig
  try {
    const out = await runSSH(ap, 'wlanconfig 2>/dev/null; echo $?');
    // wlanconfig with no args prints usage and exits non-zero, but stdout is non-empty
    if (out && out.trim().length > 0) {
      logger.info('[SSH] ' + ap.name + ' driver detected: atheros (wlanconfig present)');
      return 'atheros';
    }
  } catch (_) { /* fall through */ }

  logger.warn('[SSH] ' + ap.name + ' could not detect driver, defaulting to broadcom');
  return 'broadcom';
}

// ---------------------------------------------------------------------------
// Broadcom (wl) helpers
// ---------------------------------------------------------------------------

/**
 * Probe a single interface with wl to confirm it is a valid wireless BSS.
 */
async function probeIfaceBroadcom(ap, iface) {
  try {
    const out = await runSSH(ap, 'wl -i ' + iface + ' assoclist 2>/dev/null');
    // Any output (even empty assoclist) means the interface is valid
    return out !== undefined;
  } catch (_) {
    return false;
  }
}

/**
 * Discover wireless interfaces via ip link (wl* and eth* candidates),
 * validate each with a wl assoclist probe.
 */
async function getInterfacesBroadcom(ap) {
  try {
    const out = await runSSH(
      ap,
      "ip -o link show | awk -F': ' '{print $2}' | grep -E '^wl|^eth'"
    );
    const candidates = out.trim().split(/\n/).map(function (s) { return s.trim(); }).filter(Boolean);

    if (candidates.length === 0) {
      logger.warn('[SSH] ' + ap.name + ' no wl*/eth* interfaces found, using fallback [eth4,eth5,eth6]');
      return ['eth4', 'eth5', 'eth6'];
    }

    const results = await Promise.all(candidates.map(async function (iface) {
      const ok = await probeIfaceBroadcom(ap, iface);
      logger.debug('[SSH] ' + ap.name + ' probe ' + iface + ': ' + (ok ? 'ok' : 'skip'));
      return ok ? iface : null;
    }));

    const valid = results.filter(Boolean);

    if (valid.length === 0) {
      logger.warn('[SSH] ' + ap.name + ' no interfaces passed wl probe, using fallback [eth4,eth5,eth6]');
      return ['eth4', 'eth5', 'eth6'];
    }

    logger.info('[SSH] ' + ap.name + ' Broadcom interfaces: ' + valid.join(', '));
    return valid;

  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' Broadcom interface discovery failed: ' + err.message + ', using fallback');
    return ['eth4', 'eth5', 'eth6'];
  }
}

/**
 * Get associated client MACs from a single Broadcom interface.
 * Returns array of lowercase MAC strings.
 */
async function getAssoclistBroadcom(ap, iface) {
  const out = await runSSH(ap, 'wl -i ' + iface + ' assoclist 2>/dev/null || echo ""');
  return out
    .split('\n')
    .map(function (l) { return l.replace(/^assoclist\s+/i, '').trim().toLowerCase(); })
    .filter(isMac);
}

/**
 * Get RSSI for a single client via wl.
 * Returns integer or null.
 */
async function getRssiBroadcom(ap, iface, mac) {
  try {
    const out = await runSSH(ap, 'wl -i ' + iface + ' rssi ' + mac + ' 2>/dev/null || echo ""');
    const m = out.match(/-?\d+/);
    return m ? parseInt(m[0], 10) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Deauthenticate a client from a Broadcom interface.
 */
async function deauthBroadcom(ap, iface, mac) {
  await runSSH(ap, 'wl -i ' + iface + ' deauthenticate ' + mac + ' 2>/dev/null');
}

// ---------------------------------------------------------------------------
// Atheros / Qualcomm (wlanconfig) helpers
// ---------------------------------------------------------------------------

/**
 * Discover wireless interfaces on an Atheros-based AP.
 * Uses ifconfig (ath* interfaces) since ip link may not expose them.
 */
async function getInterfacesAtheros(ap) {
  try {
    const out = await runSSH(ap, "ifconfig 2>/dev/null | grep -E '^ath'");
    const ifaces = out.trim().split('\n')
      .map(function (l) { return l.trim().split(/\s+/)[0]; })
      .filter(Boolean);

    if (ifaces.length > 0) {
      logger.info('[SSH] ' + ap.name + ' Atheros interfaces: ' + ifaces.join(', '));
      return ifaces;
    }

    logger.warn('[SSH] ' + ap.name + ' no ath* interfaces found, using fallback [ath0,ath1]');
    return ['ath0', 'ath1'];

  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' Atheros interface discovery failed: ' + err.message + ', using fallback');
    return ['ath0', 'ath1'];
  }
}

/**
 * Parse wlanconfig <iface> list sta output.
 *
 * Output format (multiline per station):
 *   ADDR              AID CHAN TXRATE RXRATE RSSI IDLE  TXSEQ  RXSEQ  CAPS        ACAPS  ERP   STATE MAXRATE(DOT11) HTCAPS ASSOCTIME    IEs   MODE
 *   aa:bb:cc:dd:ee:ff   1    6  54M    54M  -62    0      0      0  ESs              0    b         0      0         -    00:01:23  RSN WME  11ng
 *     Maximum Tx Power     : 17
 *     HT Capability        : ...
 *     VHT Capability       : ...
 *
 * We want only lines where the first whitespace-delimited token is a valid MAC.
 * MAC = column 0, RSSI = column 5 (0-indexed).
 */
function parseWlanconfig(output) {
  const clients = [];
  output.split('\n').forEach(function (line) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) return;
    const mac = parts[0].toLowerCase();
    if (!isMac(mac)) return;
    const rssiRaw = parseInt(parts[5], 10);
    const rssi = isNaN(rssiRaw) ? null : rssiRaw;
    clients.push({ mac: mac, rssi: rssi });
  });
  return clients;
}

/**
 * Get associated clients from a single Atheros interface.
 * Returns array of { mac, rssi }.
 */
async function getAssoclistAtheros(ap, iface) {
  const out = await runSSH(ap, 'wlanconfig ' + iface + ' list sta 2>/dev/null || echo ""');
  return parseWlanconfig(out);
}

/**
 * Deauthenticate a client from an Atheros interface.
 */
async function deauthAtheros(ap, iface, mac) {
  await runSSH(ap, 'wlanconfig ' + iface + ' kick ' + mac + ' 2>/dev/null');
}

// ---------------------------------------------------------------------------
// Master node helpers (XT8 mesh)
// ---------------------------------------------------------------------------

/**
 * Read /tmp/clientlist.json from the master node.
 * Returns flat map: lowercase-mac -> { ip, rssi } or null on failure.
 */
async function fetchClientlistJson(ap) {
  try {
    const raw = await runSSH(ap, 'cat /tmp/clientlist.json 2>/dev/null');
    if (!raw || !raw.trim()) return null;
    const data = JSON.parse(raw);
    const map = {};

    // Structure: { "<AP-MAC>": { "2G": { "<client-MAC>": { ip, rssi } }, "5G": ..., "wired_mac": ... } }
    Object.values(data).forEach(function (apEntry) {
      Object.values(apEntry).forEach(function (bandEntry) {
        if (typeof bandEntry !== 'object' || bandEntry === null) return;
        Object.keys(bandEntry).forEach(function (mac) {
          const info = bandEntry[mac];
          const key = mac.toLowerCase();
          const ip = (info.ip && info.ip !== '') ? info.ip : null;
          const rssiRaw = parseInt(info.rssi, 10);
          const rssi = isNaN(rssiRaw) ? null : rssiRaw;
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
 * Returns a Set of lowercase MACs that belong to AiMesh infrastructure.
 */
async function fetchMeshNodeMacs(ap) {
  const meshMacs = new Set();

  try {
    const apRaw = await runSSH(ap, 'cat /tmp/aplist.json 2>/dev/null');
    if (apRaw && apRaw.trim()) {
      const apData = JSON.parse(apRaw);
      // { "0": { "ap2g": "MAC", "ap5g": "MAC", ... }, ... }
      Object.values(apData).forEach(function (node) {
        Object.values(node).forEach(function (mac) {
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
      Object.keys(reData).forEach(function (nodeMac) {
        if (nodeMac && nodeMac.includes(':')) meshMacs.add(nodeMac.toLowerCase());
        Object.values(reData[nodeMac]).forEach(function (mac) {
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all connected wireless clients from an AP.
 * Automatically detects the driver (Broadcom/Atheros) unless ap.driver is set.
 *
 * @param {object} ap           - AP config entry
 * @param {object|null} clientlistMap - flat MAC->{ ip, rssi } map from master (may be null)
 * @param {Set|null}   meshMacs      - set of mesh-infrastructure MACs (may be null)
 * @returns {Array} clients
 */
async function fetchClientsFromAP(ap, clientlistMap, meshMacs) {
  const clients = [];
  logger.info('[SSH] Polling AP: ' + ap.name + ' (' + ap.host + ':' + (ap.ssh_port || 22) + ')');

  try {
    const driver = await detectDriver(ap);

    // ARP table as IP fallback
    const arpOut = await runSSH(ap, 'cat /proc/net/arp 2>/dev/null || echo ""');
    const arpMacToIp = {};
    arpOut.split('\n').forEach(function (line) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4 && parts[3] && parts[3].includes(':')) {
        arpMacToIp[parts[3].toLowerCase()] = parts[0];
      }
    });
    logger.debug('[SSH] ' + ap.name + ' ARP entries: ' + Object.keys(arpMacToIp).length);

    const seenMacs = new Set();

    if (driver === 'atheros') {
      // -----------------------------------------------------------------------
      // Atheros / Qualcomm path
      // -----------------------------------------------------------------------
      const ifaces = await getInterfacesAtheros(ap);

      for (let i = 0; i < ifaces.length; i++) {
        const iface = ifaces[i];
        try {
          const stations = await getAssoclistAtheros(ap, iface);
          logger.info('[SSH] ' + ap.name + ' iface ' + iface + ': ' + stations.length + ' client(s)');

          for (let j = 0; j < stations.length; j++) {
            const { mac, rssi: ifaceRssi } = stations[j];
            if (seenMacs.has(mac)) {
              logger.debug('[SSH] ' + ap.name + ' skipping duplicate MAC ' + mac);
              continue;
            }
            seenMacs.add(mac);

            const isMeshNode = meshMacs ? meshMacs.has(mac) : false;

            // IP: clientlist -> ARP
            const clEntry = clientlistMap ? clientlistMap[mac] : null;
            const ip = (clEntry && clEntry.ip) ? clEntry.ip : (arpMacToIp[mac] || null);

            // RSSI: clientlist -> wlanconfig output
            let rssi = (clEntry && clEntry.rssi !== null) ? clEntry.rssi : ifaceRssi;

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
          logger.warn('[SSH] ' + ap.name + ' failed to query ' + iface + ': ' + ifaceErr.message);
        }
      }

    } else {
      // -----------------------------------------------------------------------
      // Broadcom (wl) path
      // -----------------------------------------------------------------------
      const ifaces = await getInterfacesBroadcom(ap);

      for (let i = 0; i < ifaces.length; i++) {
        const iface = ifaces[i];
        try {
          const macs = await getAssoclistBroadcom(ap, iface);
          logger.info('[SSH] ' + ap.name + ' iface ' + iface + ': ' + macs.length + ' client(s)');

          for (let j = 0; j < macs.length; j++) {
            const mac = macs[j];
            if (seenMacs.has(mac)) {
              logger.debug('[SSH] ' + ap.name + ' skipping duplicate MAC ' + mac);
              continue;
            }
            seenMacs.add(mac);

            const isMeshNode = meshMacs ? meshMacs.has(mac) : false;

            // IP: clientlist -> ARP
            const clEntry = clientlistMap ? clientlistMap[mac] : null;
            const ip = (clEntry && clEntry.ip) ? clEntry.ip : (arpMacToIp[mac] || null);

            // RSSI: clientlist -> wl rssi fallback
            let rssi = (clEntry && clEntry.rssi !== null) ? clEntry.rssi : null;
            if (rssi === null) {
              rssi = await getRssiBroadcom(ap, iface, mac);
              if (rssi !== null) {
                logger.debug('[SSH] ' + ap.name + ' wl rssi fallback for ' + mac + ': ' + rssi);
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
          logger.warn('[SSH] ' + ap.name + ' failed to query ' + iface + ': ' + ifaceErr.message);
        }
      }
    }

    logger.info('[SSH] ' + ap.name + ' done: ' + clients.length + ' client(s) total');

  } catch (err) {
    logger.error('[SSH] Fatal error polling ' + ap.name + ': ' + err.message);
  }

  return clients;
}

/**
 * Disconnect/kick a client from an AP.
 * Uses the correct deauth command based on the detected/configured driver.
 */
async function disconnectClient(ap, mac) {
  logger.info('[SSH] Kicking client ' + mac + ' from AP ' + ap.name);
  const driver = await detectDriver(ap);
  let kicked = false;

  if (driver === 'atheros') {
    const ifaces = await getInterfacesAtheros(ap);
    for (let i = 0; i < ifaces.length; i++) {
      try {
        await deauthAtheros(ap, ifaces[i], mac);
        logger.info('[SSH] ' + ap.name + ': kicked ' + mac + ' on ' + ifaces[i]);
        kicked = true;
      } catch (err) {
        logger.warn('[SSH] ' + ap.name + ': kick on ' + ifaces[i] + ' failed: ' + err.message);
      }
    }
  } else {
    const ifaces = await getInterfacesBroadcom(ap);
    for (let i = 0; i < ifaces.length; i++) {
      try {
        await deauthBroadcom(ap, ifaces[i], mac);
        logger.info('[SSH] ' + ap.name + ': deauthenticated ' + mac + ' on ' + ifaces[i]);
        kicked = true;
      } catch (err) {
        logger.warn('[SSH] ' + ap.name + ': deauth on ' + ifaces[i] + ' failed: ' + err.message);
      }
    }
  }

  return kicked;
}

module.exports = { fetchClientsFromAP, fetchClientlistJson, fetchMeshNodeMacs, disconnectClient };
