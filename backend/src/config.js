'use strict';

const fs   = require('fs');
const yaml = require('js-yaml');
const path = require('path');

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, '../../config.yaml');

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return yaml.load(raw);
  } catch (err) {
    console.error('Failed to load config:', err.message);
    process.exit(1);
  }
}

/**
 * Returns a normalised ha_discovery config object, or null when disabled.
 *
 * Supported config.yaml shape:
 *   ha_discovery:
 *     enabled: true          # default: false
 *     prefix: homeassistant  # default: "homeassistant"
 */
function getHaDiscoveryConfig(cfg) {
  var hd = cfg && cfg.ha_discovery;
  if (!hd || !hd.enabled) return null;
  return {
    enabled: true,
    prefix:  (typeof hd.prefix === 'string' && hd.prefix.length) ? hd.prefix : 'homeassistant',
  };
}

module.exports = { loadConfig, getHaDiscoveryConfig };
