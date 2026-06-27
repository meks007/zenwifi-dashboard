const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const configModule = require('./config');
const sshModule = require('./ssh');
const mqttModule = require('./mqtt');
const logger = require('./logger');
const ouiModule = require('./oui');

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

let currentClients = new Map();
let prevClients = new Map();
let apStatus = {};

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(function(ws) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function broadcastState() {
  broadcast({
    type: 'clients',
    clients: Array.from(currentClients.values()),
    apStatus: apStatus,
    mqttConnected: mqttModule.isConnected(),
    timestamp: new Date().toISOString(),
  });
}

async function poll() {
  const freshClients = new Map();

  // Fetch clientlist.json and mesh node MACs from master once per poll cycle
  let clientlistMap = null;
  let meshMacs = new Set();

  if (masterAp) {
    clientlistMap = await sshModule.fetchClientlistJson(masterAp);
    if (!clientlistMap) {
      logger.warn('[Poll] clientlist.json unavailable from master ' + masterAp.name + ', falling back to ARP only');
    }
    meshMacs = await sshModule.fetchMeshNodeMacs(masterAp);
  } else {
    logger.warn('[Poll] No master AP configured (master: true). IP resolution will use ARP only.');
  }

  await Promise.allSettled(aps.map(async function(ap) {
    try {
      const clients = await sshModule.fetchClientsFromAP(ap, clientlistMap, meshMacs);
      clients.forEach(function(c) {
        freshClients.set(c.mac, Object.assign({}, c, {
          vendor: c.isMeshNode ? null : ouiModule.lookup(c.mac),
        }));
      });
      apStatus[ap.name] = { online: true, lastSeen: new Date().toISOString(), error: null };
    } catch (err) {
      logger.error('[Poll] AP ' + ap.name + ' failed: ' + err.message);
      apStatus[ap.name] = {
        online: false,
        lastSeen: apStatus[ap.name] ? apStatus[ap.name].lastSeen : null,
        error: err.message,
      };
    }
  }));

  prevClients = currentClients;
  currentClients = freshClients;
  mqttModule.publishClientStates(prevClients, currentClients);
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
  const ap = aps.find(function(a) { return a.name === c.apName; });
  if (!ap) return { success: false, error: 'AP not found' };
  try {
    await sshModule.disconnectClient(ap, mac);
    logger.info('[Disconnect] Successfully kicked ' + mac + ' from ' + ap.name);
    setTimeout(poll, 2000);
    return { success: true };
  } catch (err) {
    logger.error('[Disconnect] Failed to kick ' + mac + ': ' + err.message);
    return { success: false, error: err.message };
  }
}

// REST endpoints
app.get('/api/clients', function(_req, res) {
  res.json({
    clients: Array.from(currentClients.values()),
    apStatus: apStatus,
    mqttConnected: mqttModule.isConnected(),
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/clients/:mac/disconnect', async function(req, res) {
  const mac = req.params.mac.toLowerCase();
  const result = await handleDisconnect(mac);
  res.status(result.success ? 200 : 400).json(result);
});

app.get('/api/logs', function(_req, res) {
  res.json({ logs: logger.list() });
});

app.get('/api/health', function(_req, res) {
  res.json({ ok: true, uptime: process.uptime() });
});

// WebSocket
wss.on('connection', function(ws) {
  logger.info('[WS] Browser client connected');

  ws.send(JSON.stringify({
    type: 'clients',
    clients: Array.from(currentClients.values()),
    apStatus: apStatus,
    mqttConnected: mqttModule.isConnected(),
    timestamp: new Date().toISOString(),
  }));

  ws.send(JSON.stringify({ type: 'log_history', logs: logger.list() }));

  ws.on('message', async function(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'disconnect' && msg.mac) {
        const result = await handleDisconnect(msg.mac.toLowerCase());
        ws.send(JSON.stringify(Object.assign({ type: 'disconnect_result', mac: msg.mac }, result)));
      }
    } catch (_e) {}
  });

  ws.on('close', function() { logger.info('[WS] Browser client disconnected'); });
});

// MQTT disconnect requests also go through handleDisconnect which guards mesh nodes
mqttModule.connect(config, async function(mac) {
  await handleDisconnect(mac.toLowerCase());
});

// Start polling
const intervalMs = (config.polling_interval_seconds || 30) * 1000;
logger.info('[Server] Starting. Polling every ' + (config.polling_interval_seconds || 30) + 's');
logger.info('[Server] Log buffer size: ' + (config.log_buffer_size || 500) + ' lines');
logger.info('[Server] APs: ' + aps.map(function(a) { return a.name + (a.master ? ' (master)' : ''); }).join(', '));
logger.info('[Server] Master AP: ' + (masterAp ? masterAp.name : 'none configured'));
logger.info('[Server] Debug logging: ' + (config.debug_logging ? 'ON' : 'OFF'));
poll();
setInterval(poll, intervalMs);

const PORT = process.env.PORT || 3001;
server.listen(PORT, function() {
  logger.info('[Server] Listening on port ' + PORT);
});
