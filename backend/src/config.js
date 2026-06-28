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

/**
 * Returns a normalised log file config object, or null when disabled.
 *
 * Supported config.yaml shape:
 *   log_file: /data/logs/zenwifi.log   # omit or leave empty to disable file logging
 *   log_file_max_bytes: 10485760        # default: 10 MB
 *   log_file_max_rotations: 3           # default: 3
 *   log_tail_lines: 100                 # lines sent to client on WS connect (default: 100)
 */
function getLogFileConfig(cfg) {
  if (!cfg || !cfg.log_file) return null;
  return {
    path:         cfg.log_file,
    maxBytes:     (cfg.log_file_max_bytes     > 0) ? cfg.log_file_max_bytes     : 10 * 1024 * 1024,
    maxRotations: (cfg.log_file_max_rotations > 0) ? cfg.log_file_max_rotations : 3,
    tailLines:    (cfg.log_tail_lines         > 0) ? cfg.log_tail_lines         : 100,
  };
}

module.exports = { loadConfig, getHaDiscoveryConfig, getLogFileConfig };
