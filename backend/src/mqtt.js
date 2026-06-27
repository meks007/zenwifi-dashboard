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
  const url = 'mqtt://' + cfg.mqtt.host + ':' + cfg.mqtt.port;
  mqttClient = mqtt.connect(url, {
    username: cfg.mqtt.username,
    password: cfg.mqtt.password,
    clientId: 'zenwifi-dashboard-' + Date.now(),
    clean: true,
    reconnectPeriod: 5000,
  });
  mqttClient.on('connect', function () {
    console.log('[MQTT] Connected to ' + url);
    const topic = getPrefix() + '/clients/+/disconnect';
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

function publishClientStates(prevClients, currentClients) {
  const prefix = getPrefix();
  currentClients.forEach(function (c, mac) {
    publish(prefix + '/clients/' + mac + '/state', 'online');
    publish(prefix + '/clients/' + mac + '/ap', c.apName);
    publish(prefix + '/clients/' + mac + '/info', { hostname: c.hostname, ip: c.ip, rssi: c.rssi, iface: c.iface });
  });
  prevClients.forEach(function (_, mac) {
    if (!currentClients.has(mac)) publish(prefix + '/clients/' + mac + '/state', 'offline');
  });
  publish(prefix + '/status', Array.from(currentClients.values()));
}

function isConnected() { return !!(mqttClient && mqttClient.connected); }

module.exports = { connect, publishClientStates, isConnected, publish };
