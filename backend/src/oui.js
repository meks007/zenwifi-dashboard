// MAC OUI vendor lookup using the 'oui' npm package.
// Falls back to 'Unknown' if not found.

let ouiLookup = null;

function init() {
  try {
    ouiLookup = require('oui');
  } catch (e) {
    console.warn('[OUI] oui package not available, vendor lookup disabled:', e.message);
  }
}

init();

function lookup(mac) {
  if (!ouiLookup || !mac) return null;
  try {
    const result = ouiLookup(mac.toUpperCase());
    if (!result) return null;
    // The oui package may return a multi-line string; use only the first line
    return result.split('\n')[0].trim() || null;
  } catch (_) {
    return null;
  }
}

module.exports = { lookup };
