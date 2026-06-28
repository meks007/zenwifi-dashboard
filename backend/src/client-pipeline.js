'use strict';

/**
 * Pure transformation helpers used by the poll pipeline in index.js.
 * No side effects, no server state, no I/O.
 */

function isIpv6(ip) {
  return typeof ip === 'string' && ip.indexOf(':') !== -1;
}

function filterIp(ip, showIpv6) {
  if (!ip) return ip;
  if (!showIpv6 && isIpv6(ip)) return null;
  return ip;
}

/**
 * Collapse per-band mesh node entries into a single entry per physical node.
 * Regular (non-mesh) clients pass through unchanged.
 */
function collapseMeshNodes(rawClients, ouiLookup) {
  var regular = [];
  var nodeMap  = new Map();

  rawClients.forEach(function(c) {
    if (!c.isMeshNode) { regular.push(c); return; }
    var nodeId = c.meshNodeId;
    if (!nodeMap.has(nodeId)) {
      nodeMap.set(nodeId, {
        mac: nodeId, ip: c.ip, hostname: null, rssi: c.rssi,
        iface: c.iface, apName: c.apName, apHost: c.apHost,
        isMeshNode: true, meshNodeId: nodeId, meshActiveMacs: [c.mac],
        vendor: ouiLookup(nodeId),
      });
    } else {
      var existing = nodeMap.get(nodeId);
      if (c.rssi !== null && (existing.rssi === null || c.rssi > existing.rssi)) existing.rssi = c.rssi;
      if (!existing.ip && c.ip) existing.ip = c.ip;
      if (!existing.meshActiveMacs.includes(c.mac)) existing.meshActiveMacs.push(c.mac);
    }
  });

  return regular.concat(Array.from(nodeMap.values()));
}

/**
 * Resolve a human-readable label for a wireless interface name.
 * Uses the interface_labels map from config if present, otherwise capitalises.
 */
function resolveIfaceLabel(ifaceName, ndCfg) {
  var labels = ndCfg && ndCfg.interface_labels;
  if (labels && typeof labels === 'object') {
    var key = (ifaceName || '').toLowerCase();
    if (labels[key]) return labels[key];
  }
  var raw = ifaceName || 'unknown';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

module.exports = { isIpv6, filterIp, collapseMeshNodes, resolveIfaceLabel };
