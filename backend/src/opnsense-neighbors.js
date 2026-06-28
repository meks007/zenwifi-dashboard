'use strict';

const { getDhcpInfo } = require('./opnsense-dhcp');
const logger          = require('./logger');

// Internal state - refreshed on every poll cycle
var neighborMap = {}; // lowercase MAC -> { ip, hostname, interface, lastSeen }

const ROWS_PER_PAGE    = 500;
const NEIGHBOR_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// HTTPS helper (shared pattern, local copy to avoid circular dep)
// ---------------------------------------------------------------------------
function fetchPage(cfg, apiPath, page, rowCount) {
  const https = require('https');
  return new Promise(function(resolve, reject) {
    var auth    = Buffer.from(cfg.api_key + ':' + cfg.api_secret).toString('base64');
    var qs      = '?rowCount=' + rowCount + '&current=' + page;
    var options = {
      hostname:           cfg.host,
      port:               cfg.port || 443,
      path:               apiPath + qs,
      method:             'GET',
      headers:            { Authorization: 'Basic ' + auth, Accept: 'application/json' },
      rejectUnauthorized: cfg.verify_ssl === true,
    };
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error('OPNsense JSON parse error on ' + apiPath + ': ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, function() { req.destroy(new Error('OPNsense request timeout: ' + apiPath)); });
    req.end();
  });
}

async function fetchAllRows(cfg, apiPath) {
  var allRows = [];
  var page    = 1;
  for (;;) {
    var result = await fetchPage(cfg, apiPath, page, ROWS_PER_PAGE);
    if (result.status < 200 || result.status >= 300) throw new Error('HTTP ' + result.status + ' from ' + apiPath);
    var rows = (result.body && result.body.rows) ? result.body.rows : [];
    if (rows.length === 0) break;
    allRows = allRows.concat(rows);
    var total = (result.body && typeof result.body.total === 'number') ? result.body.total : null;
    if (total !== null && allRows.length >= total) break;
    if (rows.length < ROWS_PER_PAGE) break;
    page += 1;
  }
  return allRows;
}

// ---------------------------------------------------------------------------
// Neighbor discovery
//
// OPNsense hostdiscovery API response schema:
//   interface_name  - e.g. "LAN" (uppercase)
//   ether_address   - MAC address
//   ip_address      - IP address
//   last_seen       - ISO datetime string, e.g. "2026-06-27 21:15:45"
// ---------------------------------------------------------------------------
async function refreshNeighbors(cfg) {
  var ndCfg = cfg.neighbor_discovery;
  if (!ndCfg || ndCfg.enabled !== true) { neighborMap = {}; return; }

  var allowedIfaces = new Set(
    (ndCfg.interfaces && ndCfg.interfaces.length > 0 ? ndCfg.interfaces : ['lan'])
      .map(function(i) { return i.toLowerCase(); })
  );

  try {
    var rows = await fetchAllRows(cfg, '/api/hostdiscovery/service/search');
    var now  = Date.now();
    var newMap = {};
    logger.debug('[OPNsense] Neighbor discovery: ' + rows.length + ' raw row(s) received; configured filter: ' + Array.from(allowedIfaces).join(', '));
    rows.forEach(function(row) {
      var iface = (row.interface_name || '').toLowerCase();
      if (!allowedIfaces.has(iface)) return;
      var lastSeenMs = null;
      var raw        = row.last_seen || null;
      if (raw) lastSeenMs = new Date(raw.replace(' ', 'T')).getTime();
      if (lastSeenMs !== null && !isNaN(lastSeenMs) && (now - lastSeenMs) > NEIGHBOR_MAX_AGE_MS) return;
      var mac = (row.ether_address || '').toLowerCase();
      if (!mac) return;
      newMap[mac] = {
        ip:        row.ip_address        || null,
        hostname:  row.organization_name || null,
        interface: iface,
        lastSeen:  lastSeenMs,
      };
    });
    neighborMap = newMap;
    logger.info('[OPNsense] Neighbor discovery: ' + Object.keys(neighborMap).length + ' host(s) on interface(s): ' + Array.from(allowedIfaces).join(', '));
  } catch (err) {
    logger.warn('[OPNsense] Neighbor discovery fetch failed (requires OPNsense 26.1+): ' + err.message);
    neighborMap = {};
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns wired clients from neighbor discovery that are not already present
 * in the ZenWifi client list, enriched with DHCP info where available.
 */
function getWiredClients(knownMacs) {
  var knownSet = new Set((knownMacs || []).map(function(m) { return m.toLowerCase(); }));
  var result   = [];
  Object.keys(neighborMap).forEach(function(mac) {
    if (knownSet.has(mac)) return;
    var info = neighborMap[mac];
    var dhcp = getDhcpInfo(mac) || {};
    result.push({
      mac:            mac,
      ip:             dhcp.ip          || info.ip       || null,
      hostname:       dhcp.hostname    || info.hostname  || null,
      description:    dhcp.description || null,
      interface:      info.interface,
      lastSeen:       info.lastSeen,
      hasReservation: dhcp.hasReservation || false,
    });
  });
  return result;
}

function isNeighborDiscoveryEnabled(cfg) {
  return !!(cfg && cfg.neighbor_discovery && cfg.neighbor_discovery.enabled === true);
}

module.exports = { refreshNeighbors, getWiredClients, isNeighborDiscoveryEnabled };
