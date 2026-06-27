const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const configModule = require('./config');
const sshModule = require('./ssh');
const mqttModule = require('./mqtt');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server: server });

const config = configModule.loadConfig();
let currentClients = new Map();
let prevClients = new Map();
let apStatus = {};

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(function (ws) {
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
  const aps = config.access_points || [];
  const freshClients = new Map();
  await Promise.allSettled(aps.map(async function (ap) {
    try {
      const clients = await sshModule.fetchClientsFromAP(ap);
      clients.forEach(function (c) { freshClients.set(c.mac, c); });
      apStatus[ap.name] = { online: true, lastSeen: new Date().toISOString(), error: null };
    } catch (err) {
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
    console.warn('[Disconnect] MAC ' + mac + ' not found');
    return { success: false, error: 'Client not found' };
  }
  const ap = (config.access_points || []).find(function (a) { return a.name === c.apName; });
  if (!ap) return { success: false, error: 'AP not found' };
  try {
    await sshModule.disconnectClient(ap, mac);
    console.log('[Disconnect] Kicked ' + mac + ' from ' + ap.name);
    setTimeout(poll, 2000);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

app.get('/api/clients', function (_req, res) {
  res.json({
    clients: Array.from(currentClients.values()),
    apStatus: apStatus,
    mqttConnected: mqttModule.isConnected(),
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/clients/:mac/disconnect', async function (req, res) {
  const mac = req.params.mac.toLowerCase();
  const result = await handleDisconnect(mac);
  res.status(result.success ? 200 : 400).json(result);
});

app.get('/api/health', function (_req, res) {
  res.json({ ok: true, uptime: process.uptime() });
});

wss.on('connection', function (ws) {
  console.log('[WS] Client connected');
  ws.send(JSON.stringify({
    type: 'clients',
    clients: Array.from(currentClients.values()),
    apStatus: apStatus,
    mqttConnected: mqttModule.isConnected(),
    timestamp: new Date().toISOString(),
  }));
  ws.on('message', async function (raw) {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'disconnect' && msg.mac) {
        const result = await handleDisconnect(msg.mac.toLowerCase());
        ws.send(JSON.stringify(Object.assign({ type: 'disconnect_result', mac: msg.mac }, result)));
      }
    } catch (_e) {}
  });
  ws.on('close', function () { console.log('[WS] Client disconnected'); });
});

mqttModule.connect(config, async function (mac) {
  await handleDisconnect(mac.toLowerCase());
});

const intervalMs = (config.polling_interval_seconds || 10) * 1000;
poll();
setInterval(poll, intervalMs);

const PORT = process.env.PORT || 3001;
server.listen(PORT, function () {
  console.log('[Server] Listening on port ' + PORT);
  console.log('[Config] Polling every ' + config.polling_interval_seconds + 's');
  console.log('[Config] APs: ' + (config.access_points || []).map(function (a) { return a.name; }).join(', '));
});
