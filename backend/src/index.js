'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const configModule = require('./config');
const sshModule = require('./ssh');
const mqttModule = require('./mqtt');
const logger = require('./logger');
const ouiModule = require('./oui');
const opnsense = require('./opnsense');
const pinger = require('./pinger');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server: server });

logger.setBroadcaster(function(payload) { broadcast(payload); });

const config = configModule.loadConfig();

logger.setDebug(!!config.debug_logging);
logger.setMaxLines(config.log_buffer_size || 500);

const aps = config.access_points || [];
const masterAp = aps.find(function(ap) { return ap.master === true; }) || null;

// How many consecutive poll failures before an AP's clients are cleared.
const FAILURE_THRESHOLD = 3;

// How often (in poll cycles) to re-run wireless interface discovery per AP.
// Discovery runs on the very first poll and then once every N cycles.
// Default: 10 (configurable via iface_discovery_interval in config.yaml).
const ifaceDiscoveryInterval = config.iface_discovery_interval || 10;

// Whether to include IPv6 addresses. Defaults to false.
const showIpv6 = config.show_ipv6 === true;

// How often (in minutes) to re-ping all discovered clients. Default: 5.
const pingIntervalMinutes = config.ping_interval_minutes || 5;

let currentClients = new Map();
let prevClients = new Map();
let apStatus = {};

// Track consecutive SSH failures per AP name.
// Cleared to 0 on any successful poll.
const apFailCount = {};
aps.forEach(function(ap) { apFailCount[ap.name] = 0; });

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(function(ws) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function broadcastState() {
  // Exclude discovered clients that are definitively offline.
  // Clients not yet checked (isOnline == null) are included so they appear
  // immediately after discovery until the first ping cycle completes.
  var visible = Array.from(currentClients.values()).filter(function(c) {
    if (c.connectionType !== 'discovered') return true;
    return pinger.isOnline(c.mac) !== false;
  });

  broadcast({
    type: 'clients',
    clients: visible,
    apStatus: apStatus,
    mqttConnected: mqttModule.isConnected(),
    timestamp: new Date().toISOString(),
  });
}

/**
 * Returns true if the given IP string is an IPv6 address (contains a colon).
 */
function isIpv6(ip) {
  return typeof ip === 'string' && ip.indexOf(':') !== -1;
}

/**
 * Filter the IP field of a client object according to the show_ipv6 setting.
 * When show_ipv6 is false (default), IPv6 addresses are replaced with null
 * so the IP column stays clean.
 */
function filterIp(ip) {
  if (!ip) return ip;
  if (!showIpv6 && isIpv6(ip)) return null;
  return ip;
}

/**
 * Collapse raw client entries that share a meshNodeId into a single row per
 * physical mesh node.
 */
function collapseMeshNodes(rawClients) {
  const regular = [];
  const nodeMap = new Map();

  rawClients.forEach(function(c) {
    if (!c.isMeshNode) {
      regular.push(c);
      return;
    }
    const nodeId = c.meshNodeId;
    if (!nodeMap.has(nodeId)) {
      nodeMap.set(nodeId, {
        mac: nodeId,
        ip: c.ip,
        hostname: null,
        rssi: c.rssi,
        iface: c.iface,
        apName: c.apName,
        apHost: c.apHost,
        isMeshNode: true,
        meshNodeId: nodeId,
        meshActiveMacs: [c.mac],
        vendor: ouiModule.lookup(nodeId),
      });
    } else {
      const existing = nodeMap.get(nodeId);
      if (c.rssi !== null && (existing.rssi === null || c.rssi > existing.rssi)) {
        existing.rssi = c.rssi;
      }
      if (!existing.ip && c.ip) existing.ip = c.ip;
      if (!existing.meshActiveMacs.includes(c.mac)) {
        existing.meshActiveMacs.push(c.mac);
      }
    }
  });

  return regular.concat(Array.from(nodeMap.values()));
}

/**
 * Resolve a human-readable label for a discovered interface name.
 * Falls back to the raw interface name (capitalised) if no label is configured.
 *
 * Config example:
 *   neighbor_discovery:
 *     interface_labels:
 *       lan: "LAN"
 *       opt1: "IoT"
 */
function resolveIfaceLabel(ifaceName, ndCfg) {
  var labels = ndCfg && ndCfg.interface_labels;
  if (labels && typeof labels === 'object') {
    var key = (ifaceName || '').toLowerCase();
    if (labels[key]) return labels[key];
  }
  // Fallback: capitalise first letter of the raw name
  var raw = ifaceName || 'unknown';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

async function poll() {
  const allRawClients = [];

  let clientlistMap = null;
  let meshMap = new Map();
  let nodeGroups = new Map();
  let neighMap = {};

  if (masterAp) {
    clientlistMap = await sshModule.fetchClientlistJson(masterAp);
    if (!clientlistMap) {
      logger.warn('[Poll] clientlist.json unavailable from master ' + masterAp.name + ', falling back to ARP only');
    }
    var meshResult = await sshModule.fetchMeshNodeMacs(masterAp);
    meshMap = meshResult.meshMap;
    nodeGroups = meshResult.nodeGroups;
    // Fetch ip neigh from master only. Satellites have incomplete neigh tables
    // and would resolve the wrong IP for other nodes' management addresses.
    neighMap = await sshModule.fetchNeighMap(masterAp);
  } else {
    logger.warn('[Poll] No master AP configured (master: true). IP resolution will use ARP only.');
  }

  await Promise.allSettled(aps.map(async function(ap) {
    try {
      const clients = await sshModule.fetchClientsFromAP(
        ap, clientlistMap, meshMap, neighMap, nodeGroups, ifaceDiscoveryInterval
      );
      // Success: reset failure counter, accept results
      apFailCount[ap.name] = 0;
      clients.forEach(function(c) { allRawClients.push(c); });
      apStatus[ap.name] = {
        online: true,
        clients: clients.filter(function(c) { return !c.isMeshNode; }).length,
        lastSeen: new Date().toISOString(),
        error: null,
      };
    } catch (err) {
      apFailCount[ap.name] = (apFailCount[ap.name] || 0) + 1;
      const failCount = apFailCount[ap.name];

      logger.error('[Poll] AP ' + ap.name + ' failed (attempt ' + failCount + '/' + FAILURE_THRESHOLD + '): ' + err.message);

      apStatus[ap.name] = {
        online: false,
        clients: apStatus[ap.name] ? (apStatus[ap.name].clients || 0) : 0,
        lastSeen: apStatus[ap.name] ? apStatus[ap.name].lastSeen : null,
        error: err.message,
      };

      if (failCount < FAILURE_THRESHOLD) {
        // Carry over the clients from the previous successful poll for this AP
        currentClients.forEach(function(c) {
          if (c.apName === ap.name) allRawClients.push(c);
        });
        logger.warn('[Poll] AP ' + ap.name + ' carrying over ' +
          Array.from(currentClients.values()).filter(function(c) { return c.apName === ap.name; }).length +
          ' client(s) from last successful poll (failure ' + failCount + '/' + FAILURE_THRESHOLD + ')');
      } else {
        logger.warn('[Poll] AP ' + ap.name + ' reached failure threshold (' + FAILURE_THRESHOLD + '), clearing its clients.');
      }
    }
  }));

  // Attach vendor to regular clients, then collapse mesh nodes to one row each
  const enriched = allRawClients.map(function(c) {
    return Object.assign({}, c, {
      vendor: c.isMeshNode ? null : ouiModule.lookup(c.mac),
    });
  });
  const collapsed = collapseMeshNodes(enriched);

  // Enrich each client with OPNsense DHCP lease and reservation data.
  // For non-mesh clients, promote dhcp.hostname and dhcp.ip to the top-level
  // fields so the frontend can display them without reading into dhcp.*.
  // Priority: reservation > dynamic lease > WiFi-side ARP/clientlist value.
  const dhcpEnriched = collapsed.map(function(c) {
    var dhcp = c.isMeshNode ? null : opnsense.getDhcpInfo(c.mac);
    var rawIp = (!c.isMeshNode && dhcp && dhcp.ip) ? dhcp.ip : (c.ip || null);
    return Object.assign({}, c, {
      connectionType: c.isMeshNode ? 'mesh' : 'wifi',
      dhcp:     dhcp,
      ip:       filterIp(rawIp),
      hostname: (!c.isMeshNode && dhcp && dhcp.hostname) ? dhcp.hostname : (c.hostname || null),
    });
  });

  // Merge discovered clients from OPNsense neighbor discovery when the feature
  // is enabled. Only hosts not already visible as a ZenWifi Wi-Fi client are
  // included.
  var allClients = dhcpEnriched;
  var ndCfg = config.opnsense && config.opnsense.neighbor_discovery;
  if (opnsense.isNeighborDiscoveryEnabled(config.opnsense)) {
    var wifiMacs       = dhcpEnriched.map(function(c) { return c.mac; });
    var discovered     = opnsense.getWiredClients(wifiMacs);
    var discoveredRows = discovered.map(function(c) {
      var ifaceLabel = resolveIfaceLabel(c.interface, ndCfg);
      var rawIp = c.ip || null;
      return {
        mac:            c.mac,
        ip:             filterIp(rawIp),
        hostname:       c.hostname,
        vendor:         ouiModule.lookup(c.mac),
        dhcp:           c.hasReservation ? { hasReservation: true, description: c.description } : null,
        // "Discovered LAN", "Discovered IoT", etc. - shown in the Access Point column
        apName:         'Discovered ' + ifaceLabel,
        apHost:         config.opnsense ? config.opnsense.host : null,
        iface:          c.interface,
        rssi:           null,
        tx_bytes:       null,
        rx_bytes:       null,
        isMeshNode:     false,
        connectionType: 'discovered',
        lastSeen:       c.lastSeen,
      };
    });

    if (discoveredRows.length > 0) {
      logger.debug('[Poll] Merging ' + discoveredRows.length + ' discovered client(s) from neighbor discovery');
    }

    // Feed IPs to the pinger and immediately kick off a cycle so newly
    // discovered hosts get their first reachability check right away rather
    // than waiting for the next scheduled interval.
    pinger.setClients(discoveredRows.map(function(c) {
      return { mac: c.mac, ip: c.ip };
    }));
    pinger.triggerCycle();

    allClients = dhcpEnriched.concat(discoveredRows);
  }

  const freshClients = new Map();
  allClients.forEach(function(c) { freshClients.set(c.mac, c); });
  prevClients = currentClients;
  currentClients = freshClients;
  mqttModule.publishClientStates(prevClients, currentClients, apStatus);
  broadcastState();
}

async function handleDisconnect(mac) {
  const c = currentClients.get(mac);
  if (!c) {
    logger.warn('[Disconnect] MAC ' + mac + ' not found in client list');
    return { success: false, error: 'Client not found' };
  }
  if (c.isMeshNode) {
    logger.warn('[Disconnect] Refusing to disconnect mesh node ' + mac);
    return { success: false, error: 'Disconnecting mesh nodes is not allowed' };
  }
  if (c.connectionType === 'discovered') {
    logger.warn('[Disconnect] Refusing to disconnect discovered client ' + mac);
    return { success: false, error: 'Disconnecting discovered clients is not supported' };
  }
  const ap = aps.find(function(a) { return a.name === c.apName; });
  if (!ap) return { success: false, error: 'AP not found' };
  try {
    const kicked = await sshModule.disconnectClient(ap, mac);
    if (kicked) {
      logger.info('[Disconnect] Successfully disconnected ' + mac + ' from ' + ap.name);
      return { success: true };
    } else {
      logger.warn('[Disconnect] No interface reported success for ' + mac);
      return { success: false, error: 'Deauth command sent but no interface confirmed success' };
    }
  } catch (err) {
    logger.error('[Disconnect] Error disconnecting ' + mac + ': ' + err.message);
    return { success: false, error: err.message };
  }
}

// REST: POST /api/disconnect { mac }
app.post('/api/disconnect', async function(req, res) {
  const mac = (req.body.mac || '').toLowerCase().trim();
  if (!mac) return res.status(400).json({ success: false, error: 'mac required' });
  const result = await handleDisconnect(mac);
  res.status(result.success ? 200 : 400).json(result);
});

// WebSocket connection handler
wss.on('connection', function(ws) {
  logger.debug('[WS] Client connected');
  // Send current state immediately on connect
  ws.send(JSON.stringify({
    type: 'clients',
    clients: Array.from(currentClients.values()),
    apStatus: apStatus,
    mqttConnected: mqttModule.isConnected(),
    timestamp: new Date().toISOString(),
  }));
  // Send log history
  ws.send(JSON.stringify({
    type: 'log_history',
    entries: logger.list(),
  }));
  ws.on('close', function() { logger.debug('[WS] Client disconnected'); });
});

const pollInterval = (config.polling_interval_seconds || 30) * 1000;
logger.info('[Server] Poll interval: ' + pollInterval / 1000 + 's');
logger.info('[Server] Interface discovery interval: every ' + ifaceDiscoveryInterval + ' poll cycle(s)');
logger.info('[Server] IPv6 addresses: ' + (showIpv6 ? 'shown' : 'hidden'));
logger.info('[Server] Discovered client ping interval: ' + pingIntervalMinutes + ' minute(s)');

mqttModule.connect(config, handleDisconnect);

// Start OPNsense DHCP polling (no-op with a warning if not configured)
opnsense.startPolling(config.opnsense);

// Start pinger - scheduled interval only; the first cycle is triggered by poll()
// immediately after the first neighbor discovery pass.
pinger.start(pingIntervalMinutes, function(mac, online) {
  logger.info('[Pinger] ' + mac + ' flipped to ' + (online ? 'online' : 'offline') + ' - broadcasting update');
  broadcastState();
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, function() {
  logger.info('[Server] Listening on port ' + PORT);
  logger.info('[Server] APs: ' + aps.map(function(a) { return a.name + (a.master ? ' (master)' : ''); }).join(', '));
  logger.info('[Server] Master AP: ' + (masterAp ? masterAp.name : 'none configured'));
  poll();
  setInterval(poll, pollInterval);
});
