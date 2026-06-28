'use strict';

const { runSSH } = require('./ssh-transport');
const logger     = require('./logger');

var MAC_RE = new RegExp('^([0-9a-f]{2}:){5}[0-9a-f]{2}$');
function isMac(str) { return MAC_RE.test(str); }

// ---------------------------------------------------------------------------
// clientlist.json
// ---------------------------------------------------------------------------

/**
 * Fetch /tmp/clientlist.json from the master AP.
 * Returns a flat map of lowercase MAC -> { ip, rssi }, or null on failure.
 */
async function fetchClientlistJson(ap) {
  try {
    var raw  = await runSSH(ap, 'cat /tmp/clientlist.json 2>/dev/null');
    if (!raw || !raw.trim()) return null;
    var data = JSON.parse(raw);
    var map  = {};
    Object.values(data).forEach(function(apEntry) {
      Object.values(apEntry).forEach(function(bandEntry) {
        if (typeof bandEntry !== 'object' || bandEntry === null) return;
        Object.keys(bandEntry).forEach(function(mac) {
          var info    = bandEntry[mac];
          var key     = mac.toLowerCase();
          var ip      = (info.ip && info.ip !== '') ? info.ip : null;
          var rssiRaw = parseInt(info.rssi, 10);
          var rssi    = isNaN(rssiRaw) ? null : rssiRaw;
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

// ---------------------------------------------------------------------------
// ip neigh show
// ---------------------------------------------------------------------------

/**
 * Fetch ip neigh show from the master node.
 * Returns a plain object mapping lowercase MAC -> IP for REACHABLE entries only.
 */
async function fetchNeighMap(ap) {
  try {
    var neighOut     = await runSSH(ap, 'ip neigh show 2>/dev/null || echo ""');
    var neighMacToIp = {};
    neighOut.split('\n').forEach(function(line) {
      var parts  = line.trim().split(new RegExp('\\s+'));
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

// ---------------------------------------------------------------------------
// AiMesh topology (aplist.json + relist.json)
// ---------------------------------------------------------------------------

/**
 * Read /tmp/aplist.json and /tmp/relist.json from the master node.
 * Returns { meshMap: Map<mac, nodeId>, nodeGroups: Map<nodeId, Set<mac>> }.
 *
 * Step 1 - relist.json is authoritative for satellites.
 * Step 2 - aplist.json adds client-facing BSSIDs, matched to the correct
 *           satellite nodeId by scanning for any known MAC in the group.
 */
async function fetchMeshNodeMacs(ap) {
  var nodeGroups = new Map();

  function ensureGroup(nodeId) {
    if (!nodeGroups.has(nodeId)) nodeGroups.set(nodeId, new Set());
  }
  function addToGroup(nodeId, mac) {
    var id = nodeId.toLowerCase();
    var m  = mac.toLowerCase();
    ensureGroup(id);
    nodeGroups.get(id).add(m);
  }
  function macToNodeId(mac) {
    var m     = mac.toLowerCase();
    var found = null;
    nodeGroups.forEach(function(macs, nodeId) { if (macs.has(m)) found = nodeId; });
    return found;
  }

  // Step 1: satellite node groups from relist.json
  try {
    var reRaw = await runSSH(ap, 'cat /tmp/relist.json 2>/dev/null');
    if (reRaw && reRaw.trim()) {
      var reData = JSON.parse(reRaw);
      Object.keys(reData).forEach(function(primaryMac) {
        var primaryMacLower = primaryMac.toLowerCase();
        if (!isMac(primaryMacLower)) return;
        var nodeId = primaryMacLower;
        addToGroup(nodeId, primaryMacLower);
        Object.values(reData[primaryMac]).forEach(function(mac) {
          if (mac) { var ml = mac.toLowerCase(); if (isMac(ml)) addToGroup(nodeId, ml); }
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
      var apData   = JSON.parse(apRaw);
      var nodeKeys = Object.keys(apData).sort(function(a, b) { return parseInt(a) - parseInt(b); });
      nodeKeys.forEach(function(nodeIndex) {
        var node   = apData[nodeIndex];
        var bssids = Object.values(node)
          .filter(function(m) { return m && isMac(m.toLowerCase()); })
          .map(function(m) { return m.toLowerCase(); });
        if (bssids.length === 0) return;
        if (nodeIndex === '0') {
          var masterId = bssids[0];
          bssids.forEach(function(b) { addToGroup(masterId, b); });
          return;
        }
        var matchedNodeId = null;
        for (var i = 0; i < bssids.length; i++) {
          var hit = macToNodeId(bssids[i]);
          if (hit) { matchedNodeId = hit; break; }
        }
        if (matchedNodeId) {
          bssids.forEach(function(b) { addToGroup(matchedNodeId, b); });
        } else {
          var provId = bssids[0];
          bssids.forEach(function(b) { addToGroup(provId, b); });
          logger.warn('[SSH] ' + ap.name + ' aplist node ' + nodeIndex + ' has no relist match, provisional nodeId ' + provId);
        }
      });
      logger.info('[SSH] ' + ap.name + ' aplist.json: ' + nodeKeys.length + ' node(s) processed');
    }
  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' aplist.json unavailable: ' + err.message);
  }

  var meshMap = new Map();
  nodeGroups.forEach(function(macs, nodeId) {
    macs.forEach(function(mac) { meshMap.set(mac, nodeId); });
  });
  var nodeCount = new Set(meshMap.values()).size;
  logger.info('[SSH] ' + ap.name + ' mesh MACs mapped: ' + meshMap.size + ' MAC(s) across ' + nodeCount + ' node(s)');
  return { meshMap: meshMap, nodeGroups: nodeGroups };
}

module.exports = { fetchClientlistJson, fetchNeighMap, fetchMeshNodeMacs };
