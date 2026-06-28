'use strict';

const db     = require('./db');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Housekeeping
//
// Scans the DB for client_seen rows whose MAC is no longer present in the
// active client set. For each stale row:
//   1. Publishes state=offline and last_seen (the stored first_seen timestamp)
//      to MQTT so downstream consumers know the client is gone.
//   2. Deletes the row from the DB.
//
// This catches records that were not cleaned up at runtime -- for example
// when the server was restarted while a client was already offline.
//
// Public API:
//   housekeeping.run(getCurrentClients, mqttPublish, topicPrefix)
//
//   housekeeping.start(intervalMinutes, getCurrentClients, mqttPublish, topicPrefix)
//     Runs once shortly after startup, then on a fixed interval.
// ---------------------------------------------------------------------------

function run(getCurrentClients, mqttPublish, topicPrefix) {
  var active  = getCurrentClients();
  var rows    = db.getAllRows();
  var prefix  = topicPrefix || 'zenwifi';
  var evicted = 0;

  rows.forEach(function(row) {
    if (active.has(row.mac)) return; // still active, nothing to do

    // Use first_seen as the best available last-seen timestamp.
    var lastSeen = row.first_seen || new Date().toISOString();

    logger.info('[Housekeeping] Stale DB record: ' + row.mac +
      ' (last_seen: ' + lastSeen + ') - publishing offline and clearing');

    // Publish retained offline state so MQTT consumers see the client is gone.
    mqttPublish(prefix + '/clients/' + row.mac + '/state',     'offline', true);
    mqttPublish(prefix + '/clients/' + row.mac + '/last_seen', lastSeen,  true);

    try {
      db.deleteFirstSeen(row.mac);
      evicted++;
    } catch (err) {
      logger.error('[Housekeeping] Failed to delete DB record for ' + row.mac + ': ' + err.message);
    }
  });

  if (evicted > 0) {
    logger.info('[Housekeeping] Evicted ' + evicted + ' stale record(s) from DB');
  } else {
    logger.debug('[Housekeeping] No stale records found');
  }
}

/**
 * @param {number}   intervalMinutes  How often to run (default 60).
 * @param {function} getCurrentClients Returns the current Map<mac, client>.
 * @param {function} mqttPublish      mqtt.publish(topic, payload, retain).
 * @param {string}   topicPrefix      MQTT topic prefix, e.g. 'zenwifi'.
 */
function start(intervalMinutes, getCurrentClients, mqttPublish, topicPrefix) {
  var mins = intervalMinutes || 60;
  logger.info('[Housekeeping] Starting; will scan for stale DB records every ' + mins + ' minute(s)');

  // Delay the first run slightly so the initial poll has time to populate
  // currentClients before we compare against it.
  setTimeout(function() {
    run(getCurrentClients, mqttPublish, topicPrefix);
  }, 10000);

  setInterval(function() {
    run(getCurrentClients, mqttPublish, topicPrefix);
  }, mins * 60 * 1000);
}

module.exports = { run, start };
