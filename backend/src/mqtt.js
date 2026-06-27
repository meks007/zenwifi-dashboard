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

  if (!cfg.mqtt || !cfg.mqtt.host) {
    console.log('[MQTT] No broker configured, skipping.');
    return;
  }

  const prefix = getPrefix();
  const url = 'mqtt://' + cfg.mqtt.host + ':' + (cfg.mqtt.port || 1883);

  mqttClient = mqtt.connect(url, {
    username: cfg.mqtt.username,
    password: cfg.mqtt.password,
    clientId: 'zenwifi-dashboard-' + Date.now(),
    clean: true,
    reconnectPeriod: 5000,
    will: {
      topic: prefix + '/bridge/status',
      payload: 'offline',
      qos: 1,
      retain: true,
    },
  });

  mqttClient.on('connect', function () {
    console.log('[MQTT] Connected to ' + url);
    publish(prefix + '/bridge/status', 'online', true);
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
  mqttClient.publish(topic, msg, { retain: !!retain, qos: 1 });
}

function publishClientStates(prevClients, currentClients, apStatus) {
  const prefix = getPrefix();
  const now = new Date().toISOString();

  currentClients.forEach(function (c, mac) {
    publish(prefix + '/clients/' + mac + '/state', 'online');
    publish(prefix + '/clients/' + mac + '/last_seen', now);
    publish(prefix + '/clients/' + mac + '/ap', c.apName || '');
    publish(prefix + '/clients/' + mac + '/info', {
      hostname: c.hostname || null,
      ip: c.ip || null,
      rssi: c.rssi != null ? c.rssi : null,
      iface: c.iface || null,
      tx_bytes: c.tx_bytes != null ? c.tx_bytes : null,
      rx_bytes: c.rx_bytes != null ? c.rx_bytes : null,
      tx_errors: c.tx_errors != null ? c.tx_errors : null,
      rx_errors: c.rx_errors != null ? c.rx_errors : null,
    });
  });

  prevClients.forEach(function (_, mac) {
    if (!currentClients.has(mac)) {
      publish(prefix + '/clients/' + mac + '/state', 'offline');
    }
  });

  if (apStatus) {
    Object.keys(apStatus).forEach(function (apName) {
      const ap = apStatus[apName];
      var apClients = 0;
      currentClients.forEach(function (c) {
        if (c.apName === apName && !c.isMeshNode) apClients++;
      });
      publish(prefix + '/ap/' + apName + '/status', {
        online: !!ap.online,
        clients: apClients,
        last_seen: ap.lastSeen || null,
        error: ap.error || null,
      });
    });
  }

  var meshCount = 0;
  var regularCount = 0;
  currentClients.forEach(function (c) {
    if (c.isMeshNode) meshCount++;
    else regularCount++;
  });

  publish(prefix + '/stats', {
    total_clients: regularCount + meshCount,
    mesh_nodes: meshCount,
    regular_clients: regularCount,
    timestamp: now,
  });
}

function isConnected() { return !!(mqttClient && mqttClient.connected); }

module.exports = { connect, publishClientStates, isConnected, publish };
