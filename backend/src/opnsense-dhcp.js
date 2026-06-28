'use strict';

const https  = require('https');
const logger = require('./logger');

// Internal state - refreshed on every poll cycle
var leaseMap       = {}; // lowercase MAC -> { ip, hostname, ends, type }
var reservationMap = {}; // lowercase MAC -> { ip, hostname, description }

// ---------------------------------------------------------------------------
// HTTPS helper
// ---------------------------------------------------------------------------
const ROWS_PER_PAGE = 500;

function fetchPage(cfg, apiPath, page, rowCount) {
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
// SSH helper (config.xml fallback only)
//
// OPNsense sets root's login shell to opnsense-shell (interactive menu).
// conn.exec() does NOT allocate a PTY so it bypasses the menu entirely.
// ---------------------------------------------------------------------------
function runOPNsenseSSH(cfg, command) {
  const { Client } = require('ssh2');
  return new Promise(function(resolve, reject) {
    var conn    = new Client();
    var timeout = setTimeout(function() { conn.end(); reject(new Error('OPNsense SSH exec timeout after 30s')); }, 30000);
    conn.on('ready', function() {
      logger.debug('[OPNsense SSH] Connected, running command');
      conn.exec(command, function(err, stream) {
        if (err) { clearTimeout(timeout); conn.end(); return reject(err); }
        var stdout = '';
        var stderr = '';
        stream.on('data',        function(data) { stdout += data.toString(); });
        stream.stderr.on('data', function(data) { stderr += data.toString(); });
        stream.on('close', function(code) {
          clearTimeout(timeout);
          conn.end();
          if (stderr.trim()) logger.debug('[OPNsense SSH] stderr: ' + stderr.trim());
          if (code !== 0) return reject(new Error('OPNsense SSH command exited with code ' + code + ': ' + stderr.trim()));
          resolve(stdout);
        });
      });
    });
    conn.on('error', function(err) { clearTimeout(timeout); logger.error('[OPNsense SSH] Connection error: ' + err.message); reject(err); });
    conn.connect({
      host:        cfg.ssh_host || cfg.host,
      port:        cfg.ssh_port || 22,
      username:    cfg.username || 'root',
      password:    cfg.password || undefined,
      privateKey:  cfg.key_path ? require('fs').readFileSync(cfg.key_path) : undefined,
      readyTimeout: 10000,
      hostVerifier: function() { return true; },
    });
  });
}

// ---------------------------------------------------------------------------
// Reservation sources
// ---------------------------------------------------------------------------
async function fetchReservationsKea(cfg) {
  try {
    var rows = await fetchAllRows(cfg, '/api/kea/dhcpv4/searchReservation');
    if (rows.length === 0) {
      logger.debug('[OPNsense] Kea returned 0 reservations, falling back to config.xml via SSH');
      return null;
    }
    var map = {};
    rows.forEach(function(row) {
      var mac = (row['hw-address'] || row.mac || '').toLowerCase();
      if (!mac) return;
      map[mac] = {
        ip:          row['ip-address'] || row.ipaddr || null,
        hostname:    row.hostname     || null,
        description: row.description  || row.descr  || null,
      };
    });
    logger.info('[OPNsense] Kea reservations: ' + Object.keys(map).length + ' entry(ies)');
    return map;
  } catch (err) {
    logger.debug('[OPNsense] Kea endpoint unavailable (' + err.message + '), falling back to config.xml via SSH');
    return null;
  }
}

async function fetchReservationsConfigXml(cfg) {
  try {
    logger.info('[OPNsense SSH] Connecting to ' + (cfg.ssh_host || cfg.host) + ' to read config.xml');
    var xmlText = await runOPNsenseSSH(cfg, 'cat /conf/config.xml');
    var probe   = xmlText.indexOf('<staticmap>');
    if (probe === -1) {
      logger.warn('[OPNsense] No <staticmap> found in received config.xml (' + xmlText.length + ' chars)');
      logger.debug('[OPNsense] config.xml head: ' + xmlText.slice(0, 300).replace(/\n/g, ' '));
    } else {
      logger.debug('[OPNsense] First <staticmap> at char ' + probe + ' of ' + xmlText.length);
    }
    var map     = {};
    var blockRe = /<staticmap>([\s\S]*?)<\/staticmap>/g;
    var tagRe   = function(tag, text) {
      var m = new RegExp('<' + tag + '>([^<]*)<\\/' + tag + '>').exec(text);
      return m ? m[1].trim() : null;
    };
    var block;
    while ((block = blockRe.exec(xmlText)) !== null) {
      var inner = block[1];
      var mac   = (tagRe('mac', inner) || '').toLowerCase();
      if (!mac) continue;
      map[mac] = { ip: tagRe('ipaddr', inner) || null, hostname: tagRe('hostname', inner) || null, description: tagRe('descr', inner) || null };
    }
    logger.info('[OPNsense] config.xml static maps: ' + Object.keys(map).length + ' entry(ies)');
    return map;
  } catch (err) {
    logger.warn('[OPNsense] config.xml SSH fetch failed: ' + err.message);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Refresh (called by opnsense.js coordinator)
// ---------------------------------------------------------------------------
async function refreshDhcp(cfg) {
  var leaseRows = await fetchAllRows(cfg, '/api/dhcpv4/leases/searchLease');
  var newLeaseMap = {};
  leaseRows.forEach(function(row) {
    var mac = (row.mac || '').toLowerCase();
    if (!mac) return;
    newLeaseMap[mac] = { ip: row.address || null, hostname: row.hostname || null, ends: row.ends || null, type: row.type || null };
  });
  leaseMap = newLeaseMap;

  var newReservationMap = await fetchReservationsKea(cfg);
  if (newReservationMap === null) newReservationMap = await fetchReservationsConfigXml(cfg);
  reservationMap = newReservationMap || {};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function getDhcpInfo(mac) {
  var m           = (mac || '').toLowerCase();
  var lease       = leaseMap[m]       || {};
  var reservation = reservationMap[m] || {};
  if (!lease.ip && !reservation.ip) return null;
  return {
    ip:           reservation.ip       || lease.ip       || null,
    hostname:     reservation.hostname || lease.hostname  || null,
    description:  reservation.description                 || null,
    leaseEnds:    lease.ends                              || null,
    leaseType:    lease.type                              || null,
    hasReservation: !!reservation.ip,
  };
}

module.exports = { refreshDhcp, getDhcpInfo };
