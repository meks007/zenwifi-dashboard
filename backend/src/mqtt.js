'use strict';

const mqtt = require('mqtt');

let mqttClient = null;
let appConfig = null;
let onDisconnectRequest = null;

function getPrefix() {
  return (appConfig && appConfig.mqtt && appConfig.mqtt.topic_prefix) || 'zenwifi';
}

function connect(cfg, disconnectCallback) {
  appConfig = cfg;
  onDisconnectRequest = disconnectCallback;

  const prefix = (cfg.mqtt && cfg.mqtt.topic_prefix) || 'zenwifi';
  const url = 'mqtt://' + cfg.mqtt.host + ':' + cfg.mqtt.port;

  mqttClient = mqtt.connect(url, {
    username: cfg.mqtt.username,
    password: cfg.mqtt.password,
    clientId: 'zenwifi-dashboard-' + Date.now(),
    clean: true,
    reconnectPeriod: 5000,
    // LWT: broker publishes this if the backend disconnects unexpectedly
    will: {
      topic: prefix + '/bridge/state',
      payload: 'offline',
      retain: true,
      qos: 1,
    },
  });

  mqttClient.on('connect', function () {
    console.log('[MQTT] Connected to ' + url);
    // Announce that the backend is running
    publish(prefix + '/bridge/state', 'online', true);

    const topic = prefix + '/clients/+/disconnect';
    mqttClient.subscribe(topic, { qos: 1 }, function (err) {
      if (err) console.error('[MQTT] Subscribe error:', err.message);
      else console.log('[MQTT] Subscribed to ' + topic);
    });
  });

  mqttClient.on('message', function (topic) {
    const re = new RegExp('^' + getPrefix() + '/clients/([^/]+)/disconnect$');
    const m = topic.match(re);
    if (m) {
      console.log('[MQTT] Disconnect request for MAC: ' + m[1]);
      if (onDisconnectRequest) onDisconnectRequest(m[1]);
    }
  });

  mqttClient.on('error', function (e) { console.error('[MQTT] Error:', e.message); });
  mqttClient.on('reconnect', function () { console.log('[MQTT] Reconnecting...'); });
  mqttClient.on('offline', function () { console.log('[MQTT] Offline'); });
}

function publish(topic, payload, retain) {
  if (retain === undefined) retain = true;
  if (!mqttClient || !mqttClient.connected) return;
  const msg = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
  mqttClient.publish(topic, msg, { retain: retain, qos: 1 });
}

/**
 * Publish per-client state, info, and last_seen topics.
 *
 *   <prefix>/clients/<mac>/state      online | offline
 *   <prefix>/clients/<mac>/last_seen  ISO timestamp (retained)
 *   <prefix>/clients/<mac>/ap         AP name (retained)
 *   <prefix>/clients/<mac>/info       JSON object (retained)
 */
function publishClientStates(prevClients, currentClients) {
  const prefix = getPrefix();
  const now = new Date().toISOString();

  currentClients.forEach(function (c, mac) {
    publish(prefix + '/clients/' + mac + '/state', 'online');
    publish(prefix + '/clients/' + mac + '/last_seen', now);
    publish(prefix + '/clients/' + mac + '/ap', c.apName || '');
    publish(prefix + '/clients/' + mac + '/info', {
      hostname: c.hostname || null,
      ip: c.ip || null,
      rssi: c.rssi !== undefined ? c.rssi : null,
      iface: c.iface || null,
      tx_bytes: c.tx_bytes !== undefined ? c.tx_bytes : null,
      rx_bytes: c.rx_bytes !== undefined ? c.rx_bytes : null,
      tx_rate: c.tx_rate !== undefined ? c.tx_rate : null,
      rx_rate: c.rx_rate !== undefined ? c.rx_rate : null,
    });
  });

  prevClients.forEach(function (c, mac) {
    if (!currentClients.has(mac)) {
      publish(prefix + '/clients/' + mac + '/state', 'offline');
      // Retain the last_seen from when we last saw this client
      if (c.lastSeen) {
        publish(prefix + '/clients/' + mac + '/last_seen', c.lastSeen);
      }
    }
  });
}

/**
 * Publish per-AP status topics.
 *
 *   <prefix>/aps/<safeName>/state    online | offline
 *   <prefix>/aps/<safeName>/status   { online, clientCount, lastSeen, error }
 */
function publishApStatus(apStatus) {
  const prefix = getPrefix();
  Object.keys(apStatus).forEach(function (apName) {
    const s = apStatus[apName];
    const safeName = apName.replace(new RegExp('[^a-zA-Z0-9_-]', 'g'), '_');
    publish(prefix + '/aps/' + safeName + '/state', s.online ? 'online' : 'offline');
    publish(prefix + '/aps/' + safeName + '/status', {
      online: !!s.online,
      clientCount: s.clientCount || 0,
      lastSeen: s.lastSeen || null,
      error: s.error || null,
    });
  });
}

/**
 * Publish global summary stats.
 *
 *   <prefix>/stats   { totalClients, meshNodes, timestamp }
 */
function publishStats(currentClients) {
  const prefix = getPrefix();
  let total = 0;
  let mesh = 0;
  currentClients.forEach(function (c) {
    if (c.isMeshNode) mesh++;
    else total++;
  });
  publish(prefix + '/stats', {
    totalClients: total,
    meshNodes: mesh,
    timestamp: new Date().toISOString(),
  });
}

function isConnected() { return !!(mqttClient && mqttClient.connected); }

module.exports = { connect, publishClientStates, publishApStatus, publishStats, isConnected, publish };
