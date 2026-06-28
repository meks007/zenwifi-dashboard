'use strict';

const { runSSH }             = require('./ssh-transport');
const drivers                = require('./ssh-drivers');
const { fetchClientlistJson, fetchNeighMap, fetchMeshNodeMacs } = require('./mesh');
const logger                 = require('./logger');

var MAC_RE = new RegExp('^([0-9a-f]{2}:){5}[0-9a-f]{2}$');
function isMac(str) { return MAC_RE.test(str); }

// ---------------------------------------------------------------------------
// fetchClientsFromAP
// ---------------------------------------------------------------------------

/**
 * Fetch all wireless clients from an AP.
 *
 * @param {object}      ap                    AP config entry
 * @param {object|null} clientlistMap         flat MAC->{ip,rssi} from master (or null)
 * @param {Map|null}    meshMap               Map<mac,nodeId> from fetchMeshNodeMacs (or null)
 * @param {object}      neighMacToIp          MAC->IP from fetchNeighMap on master (or {})
 * @param {Map|null}    nodeGroups            nodeId->Set<mac> from fetchMeshNodeMacs (or null)
 * @param {number}      ifaceDiscoveryInterval Re-run interface discovery every N polls
 * @returns {Array} client objects
 */
async function fetchClientsFromAP(ap, clientlistMap, meshMap, neighMacToIp, nodeGroups, ifaceDiscoveryInterval) {
  var clients = [];
  var neigh   = neighMacToIp || {};

  /**
   * Resolve the management IP for a mesh node by checking every MAC in its
   * node group against the neigh table. The primary/AP MAC is often absent
   * from ip-neigh because the router only sees the backhaul STA MAC at L2.
   */
  function resolveNeighIp(nodeId) {
    if (neigh[nodeId]) return neigh[nodeId];
    if (!nodeGroups) return null;
    var group = nodeGroups.get(nodeId);
    if (!group) return null;
    var found = null;
    group.forEach(function(groupMac) { if (!found && neigh[groupMac]) found = neigh[groupMac]; });
    return found;
  }

  logger.info('[SSH] Polling AP: ' + ap.name + ' (' + ap.host + ':' + (ap.ssh_port || 22) + ')');

  try {
    var cached = await drivers.resolveIfaceCache(ap, ifaceDiscoveryInterval);
    var driver = cached.driver;

    // ARP table for regular client IP resolution
    var arpOut      = await runSSH(ap, 'cat /proc/net/arp 2>/dev/null || echo ""');
    var arpMacToIp  = {};
    arpOut.split('\n').forEach(function(line) {
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
          var stations = await drivers.getAssoclistAtheros(ap, athIface);
          logger.info('[SSH] ' + ap.name + ' iface ' + athIface + ': ' + stations.length + ' client(s)');
          var statsMap = await drivers.getAllStaStatsAtheros(ap, athIface);
          for (var si = 0; si < stations.length; si++) {
            var staMac  = stations[si].mac;
            var staRssi = stations[si].rssi;
            if (seenMacs.has(staMac)) continue;
            seenMacs.add(staMac);
            var meshNodeId = meshMap ? (meshMap.get(staMac) || null) : null;
            var clEntry    = clientlistMap ? clientlistMap[staMac] : null;
            var ip         = (clEntry && clEntry.ip) ? clEntry.ip
              : (meshNodeId !== null ? resolveNeighIp(meshNodeId) : (arpMacToIp[staMac] || null));
            var rssi       = (clEntry && clEntry.rssi !== null) ? clEntry.rssi : staRssi;
            var stats      = statsMap.get(staMac) || { tx_bytes: null, rx_bytes: null };
            clients.push({ mac: staMac, ip: ip, hostname: null, rssi: rssi, iface: athIface,
              apName: ap.name, apHost: ap.host, isMeshNode: meshNodeId !== null, meshNodeId: meshNodeId,
              tx_bytes: stats.tx_bytes, rx_bytes: stats.rx_bytes });
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
          var macs = await drivers.getAssoclistBroadcom(ap, bcIface);
          logger.info('[SSH] ' + ap.name + ' iface ' + bcIface + ': ' + macs.length + ' client(s)');
          for (var mi = 0; mi < macs.length; mi++) {
            var mac = macs[mi];
            if (seenMacs.has(mac)) continue;
            seenMacs.add(mac);
            var meshId  = meshMap ? (meshMap.get(mac) || null) : null;
            var clE     = clientlistMap ? clientlistMap[mac] : null;
            var macIp   = (clE && clE.ip) ? clE.ip
              : (meshId !== null ? resolveNeighIp(meshId) : (arpMacToIp[mac] || null));
            var macRssi = (clE && clE.rssi !== null) ? clE.rssi : null;
            if (macRssi === null) {
              macRssi = await drivers.getRssiBroadcom(ap, bcIface, mac);
              if (macRssi !== null) logger.debug('[SSH] ' + ap.name + ' wl rssi fallback for ' + mac + ': ' + macRssi);
            }
            var bcStats = await drivers.getStatsBroadcom(ap, bcIface, mac);
            clients.push({ mac: mac, ip: macIp, hostname: null, rssi: macRssi, iface: bcIface,
              apName: ap.name, apHost: ap.host, isMeshNode: meshId !== null, meshNodeId: meshId,
              tx_bytes: bcStats.tx_bytes, rx_bytes: bcStats.rx_bytes });
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
  drivers.incrementPollCount(ap);
  return clients;
}

// ---------------------------------------------------------------------------
// disconnectClient
// ---------------------------------------------------------------------------
async function disconnectClient(ap, mac) {
  logger.info('[SSH] Kicking client ' + mac + ' from AP ' + ap.name);
  // Use the warm cache if available; fall back to live discovery if cold.
  var cached = await drivers.resolveIfaceCache(ap, drivers.ifaceCache && drivers.ifaceCache[ap.name] ? Infinity : 1);
  var driver = cached.driver;
  var kicked = false;

  if (driver === 'atheros') {
    var athIfaces = cached.ifaces;
    for (var ai = 0; ai < athIfaces.length; ai++) {
      try {
        await drivers.deauthAtheros(ap, athIfaces[ai], mac);
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
        await drivers.deauthBroadcom(ap, bcIfaces[bi], mac);
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
