'use strict';

const express      = require('express');
const http         = require('http');
const WebSocket    = require('ws');
const cors         = require('cors');
const logger       = require('./logger');

// Wire up the WebSocket broadcaster before any other module is loaded so that
// every log entry -- including those emitted during require() and loadConfig()
// -- is queued and flushed to connected clients the moment the WS server is
// ready. The queue in logger.js holds entries until setBroadcaster() is called.
const app    = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server: server });

logger.setBroadcaster(function(payload) { broadcast(payload); });

// All other requires happen after the broadcaster is wired up so their
// module-level log calls (e.g. oui.js warn on missing oui-data) are captured.
const configModule = require('./config');
const sshModule    = require('./ssh');
const mqttModule   = require('./mqtt');
const ouiModule    = require('./oui');
const opnsense     = require('./opnsense');
const pinger       = require('./pinger');
const db           = require('./db');
const housekeeping = require('./housekeeping');
const { registerRoutes }                                 = require('./routes');
const { filterIp, collapseMeshNodes, resolveIfaceLabel } = require('./client-pipeline');
const pkg          = require('../package.json');

const config      = configModule.loadConfig();
const haDiscovery = configModule.getHaDiscoveryConfig(config);
logger.setDebug(!!config.debug_logging);

// File-backed logging: must be initialised before any logger.info/warn/error
// calls so that startup messages land in the log file.
var logFileCfg = configModule.getLogFileConfig(config);
if (logFileCfg) {
  logger.initFileLog(logFileCfg.path, logFileCfg.maxBytes, logFileCfg.maxRotations);
  logger.info('[Logger] File logging enabled: ' + logFileCfg.path);
}

const aps                    = config.access_points || [];
const masterAp               = aps.find(function(ap) { return ap.master === true; }) || null;
const FAILURE_THRESHOLD      = 3;
const ifaceDiscoveryInterval = config.iface_discovery_interval || 10;
const showIpv6               = config.show_ipv6 === true;
const pingIntervalMinutes    = config.ping_interval_minutes || 5;

let currentClients = new Map();
let prevClients    = new Map();
let apStatus       = {};
var dbHealthy      = true;
const apFailCount = {};
aps.forEach(function(ap) { apFailCount[ap.name] = 0; });

// Tracks MACs for which an HA discovery payload has already been published.
// We only call publishDiscovery when a MAC first appears (or re-appears after
// being unpublished). This avoids re-publishing the same retained payload on
// every poll cycle.
const haPublishedMacs = new Set();

// ---------------------------------------------------------------------------
// WebSocket broadcast
// ---------------------------------------------------------------------------
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(function(ws) { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

function broadcastState() {
  var visible = Array.from(currentClients.values()).filter(function(c) {
    if (c.connectionType !== 'discovered') return true;
    return pinger.isOnline(c.mac) !== false;
  });
  broadcast({
    type:          'clients',
    clients:       visible,
    apStatus:      apStatus,
    mqttConnected: mqttModule.isConnected(),
    dbHealthy:     dbHealthy,
    version:       pkg.version,
    repoUrl:       pkg.repository.url,
    timestamp:     new Date().toISOString(),
  });
}
// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------
async function poll() {
  const allRawClients = [];
  let clientlistMap   = null;
  let meshMap         = new Map();
  let nodeGroups      = new Map();
  let neighMap        = {};
  if (masterAp) {
    clientlistMap = await sshModule.fetchClientlistJson(masterAp);
    if (!clientlistMap) logger.warn('[Poll] clientlist.json unavailable from master ' + masterAp.name + ', falling back to ARP only');
    var meshResult = await sshModule.fetchMeshNodeMacs(masterAp);
    meshMap    = meshResult.meshMap;
    nodeGroups = meshResult.nodeGroups;
    neighMap   = await sshModule.fetchNeighMap(masterAp);
  } else {
    logger.warn('[Poll] No master AP configured (master: true). IP resolution will use ARP only.');
  }
  await Promise.allSettled(aps.map(async function(ap) {
    try {
      const clients = await sshModule.fetchClientsFromAP(ap, clientlistMap, meshMap, neighMap, nodeGroups, ifaceDiscoveryInterval);
      apFailCount[ap.name] = 0;
      clients.forEach(function(c) { allRawClients.push(c); });
      apStatus[ap.name] = { online: true, clients: clients.filter(function(c) { return !c.isMeshNode; }).length, lastSeen: new Date().toISOString(), error: null };
    } catch (err) {
      apFailCount[ap.name] = (apFailCount[ap.name] || 0) + 1;
      const failCount = apFailCount[ap.name];
      logger.error('[Poll] AP ' + ap.name + ' failed (attempt ' + failCount + '/' + FAILURE_THRESHOLD + '): ' + err.message);
      apStatus[ap.name] = { online: false, clients: apStatus[ap.name] ? (apStatus[ap.name].clients || 0) : 0, lastSeen: apStatus[ap.name] ? apStatus[ap.name].lastSeen : null, error: err.message };
      if (failCount < FAILURE_THRESHOLD) {
        currentClients.forEach(function(c) { if (c.apName === ap.name) allRawClients.push(c); });
        logger.warn('[Poll] AP ' + ap.name + ' carrying over ' + Array.from(currentClients.values()).filter(function(c) { return c.apName === ap.name; }).length + ' client(s) from last successful poll (failure ' + failCount + '/' + FAILURE_THRESHOLD + ')');
      } else {
        logger.warn('[Poll] AP ' + ap.name + ' reached failure threshold (' + FAILURE_THRESHOLD + '), clearing its clients.');
      }
    }
  }));
  const enriched = allRawClients.map(function(c) {
    return Object.assign({}, c, { vendor: c.isMeshNode ? null : ouiModule.lookup(c.mac) });
  });
  const collapsed    = collapseMeshNodes(enriched, ouiModule.lookup);
  const dhcpEnriched = collapsed.map(function(c) {
    var dhcp   = c.isMeshNode ? null : opnsense.getDhcpInfo(c.mac);
    var rawIp  = (!c.isMeshNode && dhcp && dhcp.ip) ? dhcp.ip : (c.ip || null);
    return Object.assign({}, c, {
      connectionType: c.isMeshNode ? 'mesh' : 'wifi',
      dhcp:           dhcp,
      ip:             filterIp(rawIp, showIpv6),
      hostname:       (!c.isMeshNode && dhcp && dhcp.hostname) ? dhcp.hostname : (c.hostname || null),
    });
  });
  var allClients = dhcpEnriched;
  var ndCfg      = config.opnsense && config.opnsense.neighbor_discovery;
  if (opnsense.isNeighborDiscoveryEnabled(config.opnsense)) {
    var wifiMacs = [];
    dhcpEnriched.forEach(function(c) {
      wifiMacs.push(c.mac);
      if (c.isMeshNode && Array.isArray(c.meshActiveMacs)) c.meshActiveMacs.forEach(function(m) { wifiMacs.push(m); });
    });

    var discovered     = opnsense.getWiredClients(wifiMacs);
    var discoveredRows = discovered.map(function(c) {
      var ifaceLabel = resolveIfaceLabel(c.interface, ndCfg);
      return {
        mac:            c.mac,
        ip:             filterIp(c.ip || null, showIpv6),
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
    if (discoveredRows.length > 0) logger.debug('[Poll] Merging ' + discoveredRows.length + ' discovered client(s) from neighbor discovery');
    pinger.setClients(discoveredRows.map(function(c) { return { mac: c.mac, ip: c.ip }; }));
    pinger.triggerCycle();
    allClients = dhcpEnriched.concat(discoveredRows);
  }

  const now          = new Date().toISOString();
  const freshClients = new Map();
  allClients.forEach(function(c) { freshClients.set(c.mac, c); });
  try {
    freshClients.forEach(function(c, mac) {
      var prev        = prevClients.get(mac);
      var typeChanged = prev && prev.connectionType !== c.connectionType;
      if (typeChanged) {
        // Connection type changed (e.g. wifi -> discovered): treat as a new session.
        db.setFirstSeen(mac, now);
        logger.debug('[DB] first_seen reset for ' + mac + ': connection type changed (' + prev.connectionType + ' -> ' + c.connectionType + ')');

        // When a client drops off WiFi and appears as a discovered (wired) client,
        // immediately ping it so reachability is known without waiting for the next
        // scheduled cycle. Fire-and-forget: the result updates statusMap and triggers
        // broadcastState() via the onStateChange callback.
        if (prev.connectionType === 'wifi' && c.connectionType === 'discovered') {
          logger.info('[Poll] ' + mac + ' transitioned wifi -> discovered, triggering immediate ping');
          pinger.pingClient(mac).catch(function(err) {
            logger.warn('[Poll] Immediate ping for ' + mac + ' failed: ' + err.message);
          });
        }
      } else if (!db.getFirstSeen(mac)) {
        // New client, or returned after its record was cleared when it disappeared.
        db.setFirstSeen(mac, now);
        logger.debug('[DB] first_seen set for ' + mac + ': new client');
      }
    });
    prevClients.forEach(function(_c, mac) {
      if (!freshClients.has(mac)) { db.deleteFirstSeen(mac); logger.debug('[DB] first_seen cleared for ' + mac); }
    });
    freshClients.forEach(function(c, mac) {
      c.first_seen = db.getFirstSeen(mac) || null;
      if (c.connectionType === 'discovered') {
        var ps = pinger.getStatus(mac);
        if (ps) {
          c.last_ping_at     = ps.last_ping_at     || null;
          c.last_ping_result = ps.last_ping_result || null;
        } else {
          var dbPing         = db.getLastPing(mac);
          c.last_ping_at     = dbPing ? dbPing.last_ping_at     : null;
          c.last_ping_result = dbPing ? dbPing.last_ping_result : null;
        }
      }
    });
    if (!dbHealthy) { dbHealthy = true; logger.info('[DB] Database recovered.'); broadcast({ type: 'db_status', healthy: true }); }
  } catch (dbErr) {
    logger.error('[DB] Error during timestamp update: ' + dbErr.message);
    if (dbHealthy) { dbHealthy = false; broadcast({ type: 'db_status', healthy: false }); }
  }

  prevClients    = currentClients;
  currentClients = freshClients;
  mqttModule.publishClientStates(prevClients, currentClients, apStatus, pinger.isOnline);

  // ---------------------------------------------------------------------------
  // HA MQTT Discovery: publish only when a client first appears or re-appears.
  // Unpublish when a client leaves and remove it from the published set so that
  // if it returns later the discovery payload is re-published correctly.
  // Mesh nodes are skipped -- they are not tracked as individual HA devices.
  // ---------------------------------------------------------------------------
  if (haDiscovery) {
    currentClients.forEach(function(c, mac) {
      if (c.isMeshNode || c.connectionType === 'discovered') return;
      if (!haPublishedMacs.has(mac)) {
        mqttModule.publishDiscovery(mac, haDiscovery);
        haPublishedMacs.add(mac);
      }
    });
    prevClients.forEach(function(_c, mac) {
      if (!currentClients.has(mac)) {
        mqttModule.unpublishDiscovery(mac, haDiscovery);
        haPublishedMacs.delete(mac);
      }
    });
  }

  broadcastState();
}
// ---------------------------------------------------------------------------
// Disconnect handler
// ---------------------------------------------------------------------------
async function handleDisconnect(mac) {
  const c = currentClients.get(mac);
  if (!c)             return { success: false, error: 'Client not found' };
  if (c.isMeshNode)   return { success: false, error: 'Disconnecting mesh nodes is not allowed' };
  if (c.connectionType === 'discovered') return { success: false, error: 'Disconnecting discovered clients is not supported' };
  const ap = aps.find(function(a) { return a.name === c.apName; });
  if (!ap) return { success: false, error: 'AP not found' };
  try {
    const kicked = await sshModule.disconnectClient(ap, mac);
    if (kicked) {
      logger.info('[Disconnect] Successfully disconnected ' + mac + ' from ' + ap.name);
      return { success: true };
    }
    logger.warn('[Disconnect] No interface reported success for ' + mac);
    return { success: false, error: 'Deauth command sent but no interface confirmed success' };
  } catch (err) {
    logger.error('[Disconnect] Error disconnecting ' + mac + ': ' + err.message);
    return { success: false, error: err.message };
  }
}
// ---------------------------------------------------------------------------
// Ping handler (on-demand single-client ping)
// ---------------------------------------------------------------------------
async function handlePing(mac) {
  const c = currentClients.get(mac);
  if (!c)                                return { success: false, error: 'Client not found' };
  if (c.connectionType !== 'discovered') return { success: false, error: 'Ping is only supported for discovered clients' };
  try {
    var result = await pinger.pingClient(mac);
    if (result.flipped && result.online) {
      var now = new Date().toISOString();
      try {
        db.setFirstSeen(mac, now);
        var c2 = currentClients.get(mac);
        if (c2) c2.first_seen = now;
        logger.debug('[DB] first_seen reset for ' + mac + ' on manual ping (came online)');
      } catch (dbErr) {
        logger.error('[DB] Failed to reset first_seen for ' + mac + ' on manual ping: ' + dbErr.message);
      }
    }
    broadcastState();
    return { success: true, online: result.online, result: result.received + '/' + result.sent, flipped: result.flipped };
  } catch (err) {
    logger.error('[Ping] Error pinging ' + mac + ': ' + err.message);
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// HTTP routes + WebSocket
// ---------------------------------------------------------------------------
registerRoutes(app, {
  getCurrentClients: function() { return currentClients; },
  handleDisconnect:  handleDisconnect,
  handlePing:        handlePing,
  getDbHealthy:      function() { return dbHealthy; },
  logger:            logger,
});
wss.on('connection', function(ws) {
  logger.debug('[WS] Client connected');
  var visibleOnConnect = Array.from(currentClients.values()).filter(function(c) {
    if (c.connectionType !== 'discovered') return true;
    return pinger.isOnline(c.mac) !== false;
  });
  ws.send(JSON.stringify({
    type:          'clients',
    clients:       visibleOnConnect,
    apStatus:      apStatus,
    mqttConnected: mqttModule.isConnected(),
    dbHealthy:     dbHealthy,
    version:       pkg.version,
    repoUrl:       pkg.repository.url,
    timestamp:     new Date().toISOString(),
  }));
  // Send the last N log lines on connect so the frontend has immediate history.
  ws.send(JSON.stringify({ type: 'log_history', entries: logger.tail(logFileCfg ? logFileCfg.tailLines : 100) }));
  ws.on('message', function(raw) {
    try {
      var msg = JSON.parse(raw);
      // Client can request more history: { type: 'request_log_history', all: true }
      // or a specific count:             { type: 'request_log_history', n: 500 }
      if (msg.type === 'request_log_history') {
        var n = (msg.all === true) ? 0 : (msg.n || 100);
        ws.send(JSON.stringify({ type: 'log_history', entries: logger.tail(n) }));
      }
    } catch (_) {}
  });
  ws.on('close', function() { logger.debug('[WS] Client disconnected'); });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
const pollInterval = (config.polling_interval_seconds || 30) * 1000;
logger.info('[Server] Poll interval: ' + pollInterval / 1000 + 's');
logger.info('[Server] Interface discovery interval: every ' + ifaceDiscoveryInterval + ' poll cycle(s)');
logger.info('[Server] IPv6 addresses: ' + (showIpv6 ? 'shown' : 'hidden'));
logger.info('[Server] Discovered client ping interval: ' + pingIntervalMinutes + ' minute(s)');
logger.info('[Server] HA MQTT Discovery: ' + (haDiscovery ? 'enabled (prefix: ' + haDiscovery.prefix + ')' : 'disabled'));

const preloaded = db.loadAll();
logger.info('[DB] Loaded ' + preloaded.size + ' persisted first_seen record(s)');
mqttModule.connect(config, handleDisconnect);
opnsense.startPolling(config.opnsense);
pinger.start(pingIntervalMinutes, function(mac, online) {
  logger.info('[Pinger] ' + mac + ' flipped to ' + (online ? 'online' : 'offline') + ' - broadcasting update');
  var prefix = (config.mqtt && config.mqtt.topic_prefix) || 'zenwifi';
  mqttModule.publish(prefix + '/clients/' + mac + '/state', online ? 'online' : 'offline');
  // When a discovered client comes back online, reset first_seen to now so
  // the timestamp reflects the start of the current online session, not the
  // original discovery time (which may be days/weeks old).
  if (online) {
    var now = new Date().toISOString();
    try {
      db.setFirstSeen(mac, now);
      logger.debug('[DB] first_seen reset for ' + mac + ' on return to online');
    } catch (dbErr) {
      logger.error('[DB] Failed to reset first_seen for ' + mac + ': ' + dbErr.message);
    }
    // Patch the in-memory client so the next broadcastState/publishClientStates
    // immediately reflects the new first_seen without waiting for the next poll.
    var c = currentClients.get(mac);
    if (c) c.first_seen = now;
  }
  broadcastState();
});

var hkPrefix = (config.mqtt && config.mqtt.topic_prefix) || 'zenwifi';
housekeeping.start(
  config.housekeeping_interval_minutes || 60,
  function() { return currentClients; },
  function(topic, payload, retain) { mqttModule.publish(topic, payload, retain); },
  hkPrefix
);

const PORT = process.env.PORT || 3001;
server.listen(PORT, function() {
  logger.info('[Server] Listening on port ' + PORT);
  logger.info('[Server] APs: ' + aps.map(function(a) { return a.name + (a.master ? ' (master)' : ''); }).join(', '));
  logger.info('[Server] Master AP: ' + (masterAp ? masterAp.name : 'none configured'));
  poll();
  setInterval(poll, pollInterval);
});
