'use strict';

const express     = require('express');
const http        = require('http');
const WebSocket   = require('ws');
const cors        = require('cors');
const configModule = require('./config');
const sshModule   = require('./ssh');
const mqttModule  = require('./mqtt');
const logger      = require('./logger');
const ouiModule   = require('./oui');
const opnsense    = require('./opnsense');
const pinger      = require('./pinger');
const db          = require('./db');

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

const FAILURE_THRESHOLD    = 3;
const ifaceDiscoveryInterval = config.iface_discovery_interval || 10;
const showIpv6             = config.show_ipv6 === true;
const pingIntervalMinutes  = config.ping_interval_minutes || 5;

let currentClients = new Map();
let prevClients    = new Map();
let apStatus       = {};

var dbHealthy = true;

const apFailCount = {};
aps.forEach(function(ap) { apFailCount[ap.name] = 0; });

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(function(ws) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function broadcastState() {
  var visible = Array.from(currentClients.values()).filter(function(c) {
    if (c.connectionType !== 'discovered') return true;
    return pinger.isOnline(c.mac) !== false;
  });

  broadcast({
    type:         'clients',
    clients:      visible,
    apStatus:     apStatus,
    mqttConnected: mqttModule.isConnected(),
    dbHealthy:    dbHealthy,
    timestamp:    new Date().toISOString(),
  });
}

function isIpv6(ip) {
  return typeof ip === 'string' && ip.indexOf(':') !== -1;
}

function filterIp(ip) {
  if (!ip) return ip;
  if (!showIpv6 && isIpv6(ip)) return null;
  return ip;
}

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
        mac:            nodeId,
        ip:             c.ip,
        hostname:       null,
        rssi:           c.rssi,
        iface:          c.iface,
        apName:         c.apName,
        apHost:         c.apHost,
        isMeshNode:     true,
        meshNodeId:     nodeId,
        meshActiveMacs: [c.mac],
        vendor:         ouiModule.lookup(nodeId),
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

function resolveIfaceLabel(ifaceName, ndCfg) {
  var labels = ndCfg && ndCfg.interface_labels;
  if (labels && typeof labels === 'object') {
    var key = (ifaceName || '').toLowerCase();
    if (labels[key]) return labels[key];
  }
  var raw = ifaceName || 'unknown';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

async function poll() {
  const allRawClients = [];
  let clientlistMap   = null;
  let meshMap         = new Map();
  let nodeGroups      = new Map();
  let neighMap        = {};

  if (masterAp) {
    clientlistMap = await sshModule.fetchClientlistJson(masterAp);
    if (!clientlistMap) {
      logger.warn('[Poll] clientlist.json unavailable from master ' + masterAp.name + ', falling back to ARP only');
    }
    var meshResult = await sshModule.fetchMeshNodeMacs(masterAp);
    meshMap    = meshResult.meshMap;
    nodeGroups = meshResult.nodeGroups;
    neighMap   = await sshModule.fetchNeighMap(masterAp);
  } else {
    logger.warn('[Poll] No master AP configured (master: true). IP resolution will use ARP only.');
  }

  await Promise.allSettled(aps.map(async function(ap) {
    try {
      const clients = await sshModule.fetchClientsFromAP(
        ap, clientlistMap, meshMap, neighMap, nodeGroups, ifaceDiscoveryInterval
      );
      apFailCount[ap.name] = 0;
      clients.forEach(function(c) { allRawClients.push(c); });
      apStatus[ap.name] = {
        online:   true,
        clients:  clients.filter(function(c) { return !c.isMeshNode; }).length,
        lastSeen: new Date().toISOString(),
        error:    null,
      };
    } catch (err) {
      apFailCount[ap.name] = (apFailCount[ap.name] || 0) + 1;
      const failCount = apFailCount[ap.name];
      logger.error('[Poll] AP ' + ap.name + ' failed (attempt ' + failCount + '/' + FAILURE_THRESHOLD + '): ' + err.message);
      apStatus[ap.name] = {
        online:   false,
        clients:  apStatus[ap.name] ? (apStatus[ap.name].clients || 0) : 0,
        lastSeen: apStatus[ap.name] ? apStatus[ap.name].lastSeen : null,
        error:    err.message,
      };
      if (failCount < FAILURE_THRESHOLD) {
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

  const enriched = allRawClients.map(function(c) {
    return Object.assign({}, c, { vendor: c.isMeshNode ? null : ouiModule.lookup(c.mac) });
  });
  const collapsed = collapseMeshNodes(enriched);

  const dhcpEnriched = collapsed.map(function(c) {
    var dhcp  = c.isMeshNode ? null : opnsense.getDhcpInfo(c.mac);
    var rawIp = (!c.isMeshNode && dhcp && dhcp.ip) ? dhcp.ip : (c.ip || null);
    return Object.assign({}, c, {
      connectionType: c.isMeshNode ? 'mesh' : 'wifi',
      dhcp:     dhcp,
      ip:       filterIp(rawIp),
      hostname: (!c.isMeshNode && dhcp && dhcp.hostname) ? dhcp.hostname : (c.hostname || null),
    });
  });

  var allClients = dhcpEnriched;
  var ndCfg = config.opnsense && config.opnsense.neighbor_discovery;
  if (opnsense.isNeighborDiscoveryEnabled(config.opnsense)) {
    var wifiMacs = [];
    dhcpEnriched.forEach(function(c) {
      wifiMacs.push(c.mac);
      if (c.isMeshNode && Array.isArray(c.meshActiveMacs)) {
        c.meshActiveMacs.forEach(function(m) { wifiMacs.push(m); });
      }
    });

    var discovered     = opnsense.getWiredClients(wifiMacs);
    var discoveredRows = discovered.map(function(c) {
      var ifaceLabel = resolveIfaceLabel(c.interface, ndCfg);
      var rawIp      = c.ip || null;
      return {
        mac:            c.mac,
        ip:             filterIp(rawIp),
        hostname:       c.hostname,
        vendor:         ouiModule.lookup(c.mac),
        dhcp:           c.hasReservation ? { hasReservation: true, description: c.description } : null,
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

    pinger.setClients(discoveredRows.map(function(c) { return { mac: c.mac, ip: c.ip }; }));
    pinger.triggerCycle();
    allClients = dhcpEnriched.concat(discoveredRows);
  }

  const now = new Date().toISOString();
  const freshClients = new Map();
  allClients.forEach(function(c) { freshClients.set(c.mac, c); });

  // Timestamp persistence: new MAC => write; gone MAC => delete; all => attach.
  try {
    freshClients.forEach(function(c, mac) {
      if (!prevClients.has(mac)) {
        db.setFirstSeen(mac, now);
        logger.debug('[DB] first_seen set for ' + mac);
      }
    });

    prevClients.forEach(function(_c, mac) {
      if (!freshClients.has(mac)) {
        db.deleteFirstSeen(mac);
        logger.debug('[DB] first_seen cleared for ' + mac);
      }
    });

    freshClients.forEach(function(c, mac) {
      c.first_seen = db.getFirstSeen(mac) || null;
    });

    if (!dbHealthy) {
      dbHealthy = true;
      logger.info('[DB] Database recovered.');
      broadcast({ type: 'db_status', healthy: true });
    }
  } catch (dbErr) {
    logger.error('[DB] Error during timestamp update: ' + dbErr.message);
    if (dbHealthy) {
      dbHealthy = false;
      broadcast({ type: 'db_status', healthy: false });
    }
  }

  prevClients    = currentClients;
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

app.post('/api/disconnect', async function(req, res) {
  const mac = (req.body.mac || '').toLowerCase().trim();
  if (!mac) return res.status(400).json({ success: false, error: 'mac required' });
  const result = await handleDisconnect(mac);
  res.status(result.success ? 200 : 400).json(result);
});

app.get('/api/status', function(_req, res) {
  res.json({ dbHealthy: dbHealthy });
});

wss.on('connection', function(ws) {
  logger.debug('[WS] Client connected');
  ws.send(JSON.stringify({
    type:         'clients',
    clients:      Array.from(currentClients.values()),
    apStatus:     apStatus,
    mqttConnected: mqttModule.isConnected(),
    dbHealthy:    dbHealthy,
    timestamp:    new Date().toISOString(),
  }));
  ws.send(JSON.stringify({
    type:    'log_history',
    entries: logger.list(),
  }));
  ws.on('close', function() { logger.debug('[WS] Client disconnected'); });
});

const pollInterval = (config.polling_interval_seconds || 30) * 1000;
logger.info('[Server] Poll interval: ' + pollInterval / 1000 + 's');
logger.info('[Server] Interface discovery interval: every ' + ifaceDiscoveryInterval + ' poll cycle(s)');
logger.info('[Server] IPv6 addresses: ' + (showIpv6 ? 'shown' : 'hidden'));
logger.info('[Server] Discovered client ping interval: ' + pingIntervalMinutes + ' minute(s)');

const _preloaded = db.loadAll();
logger.info('[DB] Loaded ' + _preloaded.size + ' persisted first_seen record(s)');

mqttModule.connect(config, handleDisconnect);
opnsense.startPolling(config.opnsense);

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
