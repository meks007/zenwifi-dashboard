'use strict';

const https = require('https');
const logger = require('./logger');

// Internal state - refreshed on every poll cycle
let leaseMap       = {}; // lowercase MAC -> { ip, hostname, ends, type }
let reservationMap = {}; // lowercase MAC -> { ip, hostname, description, interface }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Rows fetched per API page. OPNsense defaults to 7 rows if rowCount is
// omitted, so we always request a large page and loop until done.
const ROWS_PER_PAGE = 500;

/**
 * Fetch a single page of results from an OPNsense API endpoint.
 *
 * @param {object} cfg       OPNsense config block from config.yaml
 * @param {string} apiPath   URL path, e.g. '/api/dhcpv4/leases/searchLease'
 * @param {number} page      1-based page number
 * @param {number} rowCount  Rows per page
 */
function fetchPage(cfg, apiPath, page, rowCount) {
  return new Promise(function (resolve, reject) {
    var auth    = Buffer.from(cfg.apiKey + ':' + cfg.apiSecret).toString('base64');
    var qs      = '?rowCount=' + rowCount + '&current=' + page;
    var options = {
      hostname:           cfg.host,
      port:               cfg.port || 443,
      path:               apiPath + qs,
      method:             'GET',
      headers: {
        Authorization: 'Basic ' + auth,
        Accept:        'application/json',
      },
      rejectUnauthorized: cfg.verifySsl === true,
    };

    var req = https.request(options, function (res) {
      var data = '';
      res.on('data', function (chunk) { data += chunk; });
      res.on('end', function () {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('OPNsense JSON parse error on ' + apiPath + ': ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, function () {
      req.destroy(new Error('OPNsense request timeout: ' + apiPath));
    });
    req.end();
  });
}

/**
 * Fetch ALL rows from a paginated OPNsense API endpoint by walking pages
 * until the API reports no more rows.
 *
 * @param {object} cfg      OPNsense config block
 * @param {string} apiPath  URL path
 * @returns {Promise<Array>} Flat array of all row objects
 */
async function fetchAllRows(cfg, apiPath) {
  var allRows = [];
  var page    = 1;

  for (;;) {
    var body = await fetchPage(cfg, apiPath, page, ROWS_PER_PAGE);
    var rows = body.rows || [];

    if (rows.length === 0) break;
    allRows = allRows.concat(rows);

    // If the API reports a total we can stop early once we have everything
    var total = typeof body.total === 'number' ? body.total : null;
    if (total !== null && allRows.length >= total) break;

    // A page shorter than requested means we are on the last page
    if (rows.length < ROWS_PER_PAGE) break;

    page += 1;
  }

  return allRows;
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

async function refresh(cfg) {
  try {
    // --- Dynamic leases ---
    var leaseRows   = await fetchAllRows(cfg, '/api/dhcpv4/leases/searchLease');
    var newLeaseMap = {};
    leaseRows.forEach(function (row) {
      var mac = (row.mac || '').toLowerCase();
      if (!mac) return;
      newLeaseMap[mac] = {
        ip:       row.address  || null,
        hostname: row.hostname || null,
        ends:     row.ends     || null, // lease expiry timestamp/string
        type:     row.type     || null, // 'dynamic' or 'static'
      };
    });
    leaseMap = newLeaseMap;

    // --- Static mappings / reservations ---
    var staticRows      = await fetchAllRows(cfg, '/api/dhcpv4/settings/searchStaticMap');
    var newReservationMap = {};
    staticRows.forEach(function (row) {
      var mac = (row.mac || '').toLowerCase();
      if (!mac) return;
      newReservationMap[mac] = {
        ip:          row.ipaddr    || null,
        hostname:    row.hostname  || null,
        description: row.descr     || null,
        interface:   row.interface || null,
      };
    });
    reservationMap = newReservationMap;

    logger.debug(
      '[OPNsense] Refreshed: ' + Object.keys(leaseMap).length + ' lease(s), ' +
      Object.keys(reservationMap).length + ' reservation(s)'
    );
  } catch (err) {
    logger.error('[OPNsense] Refresh failed: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns merged DHCP info for a given MAC address, or null if none is known.
 * Reservation data takes precedence over dynamic lease data because it is
 * admin-defined and authoritative.
 *
 * @param {string} mac  MAC address (any case, with or without colons)
 * @returns {{ip, hostname, description, leaseEnds, leaseType, hasReservation}|null}
 */
function getDhcpInfo(mac) {
  var m           = (mac || '').toLowerCase();
  var lease       = leaseMap[m]       || {};
  var reservation = reservationMap[m] || {};

  if (!lease.ip && !reservation.ip) return null;

  return {
    ip:             reservation.ip       || lease.ip       || null,
    hostname:       reservation.hostname || lease.hostname || null,
    description:    reservation.description                || null,
    leaseEnds:      lease.ends                             || null,
    leaseType:      lease.type                             || null,
    hasReservation: !!reservation.ip,
  };
}

/**
 * Start periodic refresh of DHCP data from OPNsense.
 * Runs immediately on call, then repeats at the configured interval.
 *
 * @param {object} cfg  opnsense config block (null/undefined if not configured)
 */
function startPolling(cfg) {
  if (!cfg || !cfg.host || !cfg.apiKey || !cfg.apiSecret) {
    logger.warn('[OPNsense] Not configured - DHCP enrichment disabled. Set opnsense.host/apiKey/apiSecret in config.yaml.');
    return;
  }
  logger.info('[OPNsense] Starting DHCP polling against ' + cfg.host + ' every ' + (cfg.pollInterval || 60) + 's');
  refresh(cfg);
  setInterval(function () { refresh(cfg); }, (cfg.pollInterval || 60) * 1000);
}

module.exports = { startPolling, getDhcpInfo };
