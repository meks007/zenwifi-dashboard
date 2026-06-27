// MAC OUI vendor lookup using the 'oui-data' npm package.
// oui-data exports a plain JSON object keyed by 6-digit uppercase OUI hex (e.g. "203706").
// Falls back to null if not found or package unavailable.

let ouiData = null;

try {
  ouiData = require('oui-data');
} catch (e) {
  console.warn('[OUI] oui-data package not available, vendor lookup disabled:', e.message);
}

function lookup(mac) {
  if (!ouiData || !mac) return null;
  try {
    // Normalise: strip separators, uppercase, take first 6 hex chars
    const hex = mac.replace(/[:\-\.]/g, '').toUpperCase().slice(0, 6);
    const entry = ouiData[hex];
    if (!entry) return null;
    // entry is a multi-line string; return only the first line (company name)
    return entry.split('\n')[0].trim() || null;
  } catch (_) {
    return null;
  }
}

module.exports = { lookup };
