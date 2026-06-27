const fs = require('fs');
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

module.exports = { loadConfig };
