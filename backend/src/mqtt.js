'use strict';

const mqtt   = require('mqtt');
const logger = require('./logger');

let mqttClient = null;
let appConfig  = null;
let onDisconnectRequest = null;

function getPrefix() {
  return (appConfig && appConfig.mqtt && appConfig.mqtt.topic_prefix) || 'zenwifi';
}

function connect(cfg, disconnectCallback) {
  appConfig = cfg;
  onDisconnectRequest = disconnectCallback;

  if (!cfg.mqtt || !cfg.mqtt.host) {
    logger.info('[MQTT] No broker configured, skipping.');
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
      topic:   prefix + '/bridge/state',
      payload: 'offline',
      qos:     1,
      retain:  true,
    },
  });

  mqttClient.on('connect', function () {
    logger.info('[MQTT] Connected to ' + url);
    publish(prefix + '/bridge/state', 'online', true);
    const topic = prefix + '/clients/+/disconnect';
    mqttClient.subscribe(topic, { qos: 1 }, function (err) {
      if (err) logger.error('[MQTT] Subscribe error: ' + err.message);
      else     logger.info('[MQTT] Subscribed to ' + topic);
    });
  });

  mqttClient.on('message', function (topic) {
    const re = new RegExp('^' + getPrefix() + '/clients/([^/]+)/disconnect$');
    const m  = topic.match(re);
    if (m) {
      logger.info('[MQTT] Disconnect request for MAC: ' + m[1]);
      if (onDisconnectRequest) onDisconnectRequest(m[1]);
    }
  });

  mqttClient.on('error',     function (e) { logger.error('[MQTT] Error: ' + e.message); });
  mqttClient.on('reconnect', function ()  { logger.warn('[MQTT] Reconnecting...'); });
  mqttClient.on('offline',   function ()  { logger.warn('[MQTT] Offline'); });
}

function publish(topic, payload, retain) {
  if (retain === undefined) retain = true;
  if (!mqttClient || !mqttClient.connected) return;
  const msg = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
  mqttClient.publish(topic, msg, { retain: !!retain, qos: 1 });
}

/**
 * Publish per-client and per-AP state topics, plus a global stats summary.
 *
 * Per client (retained):
 *   <prefix>/clients/<mac>/state        online | offline
 *   <prefix>/clients/<mac>/last_seen    ISO timestamp -- only published when online
 *   <prefix>/clients/<mac>/first_seen   ISO timestamp -- only published when online
 *   <prefix>/clients/<mac>/ap           AP name
 *   <prefix>/clients/<mac>/info         JSON: hostname, ip, rssi, iface, tx_bytes, rx_bytes
 *
 * Per AP (retained):
 *   <prefix>/ap/<name>/status           JSON: online, clients, last_seen, error
 *
 * Global (retained):
 *   <prefix>/stats                      JSON: total_clients, mesh_nodes, regular_clients, timestamp
 *
 * @param {Map}      prevClients     clients from the previous poll cycle
 * @param {Map}      currentClients  clients from the current poll cycle
 * @param {object}   apStatus        AP status map
 * @param {function} pingerIsOnline  pinger.isOnline(mac) -> true | false | null
 *                                   Pass null to skip pinger checks (all discovered = online).
 */
function publishClientStates(prevClients, currentClients, apStatus, pingerIsOnline) {
  const prefix = getPrefix();
  const now    = new Date().toISOString();

  currentClients.forEach(function (c, mac) {
    // For discovered clients, defer to the pinger: if it has confirmed the
    // client is offline, keep publishing offline so the neighbour-discovery
    // poll cycle cannot silently reset the retained topic back to online.
    var state = 'online';
    if (c.connectionType === 'discovered' && typeof pingerIsOnline === 'function') {
      if (pingerIsOnline(mac) === false) state = 'offline';
    }

    publish(prefix + '/clients/' + mac + '/state', state);

    // Do not advance last_seen or first_seen while the client is offline.
    // Timestamps should only reflect periods of confirmed reachability.
    if (state === 'online') {
      publish(prefix + '/clients/' + mac + '/last_seen',  now);
      publish(prefix + '/clients/' + mac + '/first_seen', c.first_seen || null);
    }

    publish(prefix + '/clients/' + mac + '/ap',   c.apName || '');
    publish(prefix + '/clients/' + mac + '/info', {
      hostname: c.hostname  || null,
      ip:       c.ip        || null,
      rssi:     c.rssi      != null ? c.rssi      : null,
      iface:    c.iface     || null,
      tx_bytes: c.tx_bytes  != null ? c.tx_bytes  : null,
      rx_bytes: c.rx_bytes  != null ? c.rx_bytes  : null,
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
        online:    !!ap.online,
        clients:   apClients,
        last_seen: ap.lastSeen || null,
        error:     ap.error    || null,
      });
    });
  }

  var meshCount    = 0;
  var regularCount = 0;
  currentClients.forEach(function (c) {
    if (c.isMeshNode) meshCount++;
    else regularCount++;
  });
  publish(prefix + '/stats', {
    total_clients:   regularCount + meshCount,
    mesh_nodes:      meshCount,
    regular_clients: regularCount,
    timestamp:       now,
  });
}

/**
 * Publish an HA MQTT Discovery config for a "Disconnect" button entity.
 * The device block uses only connections: [["mac", ...]] so HA merges this
 * button into the existing AsusRouter device for that client rather than
 * creating a new device entry.
 *
 * @param {string} mac          Client MAC address (any separator/case -- normalised internally)
 * @param {object} haDiscovery  Parsed ha_discovery config from getHaDiscoveryConfig()
 */
function publishDiscovery(mac, haDiscovery) {
  if (!haDiscovery || !haDiscovery.enabled) return;
  if (!mqttClient || !mqttClient.connected) return;

  // Normalise MAC to lowercase colon-separated (matches AsusRouter device registry key).
  var normMac  = mac.toLowerCase().replace(/[^0-9a-f]/g, '');
  normMac      = normMac.match(/.{1,2}/g).join(':');

  var macSafe  = normMac.replace(/:/g, '_');
  var prefix   = getPrefix();
  var haPrefix = haDiscovery.prefix || 'homeassistant';

  var configTopic = haPrefix + '/button/zenwifi_' + macSafe + '/config';

  var payload = {
    name:                    'Disconnect',
    unique_id:               'zenwifi_disconnect_' + macSafe,
    command_topic:           prefix + '/clients/' + normMac + '/disconnect',
    payload_press:           'disconnect',
    entity_category:         'config',
    device_class:            'restart',
    availability_topic:      prefix + '/clients/' + normMac + '/state',
    payload_available:       'online',
    payload_not_available:   'offline',
    device: {
      connections: [['mac', normMac]],
    },
    origin: {
      name: 'ZenWifi Dashboard',
    },
  };

  logger.debug('[HA Discovery] Publishing button for ' + normMac + ' -> ' + configTopic);
  mqttClient.publish(configTopic, JSON.stringify(payload), { retain: true, qos: 1 });
}

/**
 * Remove the HA MQTT Discovery config for a client by publishing an empty
 * retained payload. HA will remove the button entity from the device.
 *
 * @param {string} mac          Client MAC address
 * @param {object} haDiscovery  Parsed ha_discovery config from getHaDiscoveryConfig()
 */
function unpublishDiscovery(mac, haDiscovery) {
  if (!haDiscovery || !haDiscovery.enabled) return;
  if (!mqttClient || !mqttClient.connected) return;

  var normMac  = mac.toLowerCase().replace(/[^0-9a-f]/g, '');
  normMac      = normMac.match(/.{1,2}/g).join(':');
  var macSafe  = normMac.replace(/:/g, '_');
  var haPrefix = haDiscovery.prefix || 'homeassistant';

  var configTopic = haPrefix + '/button/zenwifi_' + macSafe + '/config';

  logger.info('[HA Discovery] Clearing button for ' + normMac + ' -> ' + configTopic);
  mqttClient.publish(configTopic, '', { retain: true, qos: 1 });
}

function isConnected() {
  return !!(mqttClient && mqttClient.connected);
}

module.exports = { connect, publishClientStates, publishDiscovery, unpublishDiscovery, isConnected, publish };
