'use strict';

const https  = require('https');
const { Client } = require('ssh2');
const logger = require('./logger');

// Internal state - refreshed on every poll cycle
let leaseMap       = {}; // lowercase MAC -> { ip, hostname, ends, type }
let reservationMap = {}; // lowercase MAC -> { ip, hostname, description }

// ---------------------------------------------------------------------------
// HTTPS helper (leases via REST API)
// ---------------------------------------------------------------------------

const ROWS_PER_PAGE = 500;

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
          resolve({ status: res.statusCode, body: JSON.parse(data) });
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

async function fetchAllRows(cfg, apiPath) {
  var allRows = [];
  var page    = 1;

  for (;;) {
    var result = await fetchPage(cfg, apiPath, page, ROWS_PER_PAGE);
    if (result.status < 200 || result.status >= 300) {
      throw new Error('HTTP ' + result.status + ' from ' + apiPath);
    }
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
// SSH helper for OPNsense
//
// OPNsense sets root's login shell to opnsense-shell, which presents an
// interactive numbered menu even on non-PTY exec sessions (on some versions).
// The reliable approach is to open a PTY-backed shell channel, wait for the
// menu prompt, send "8" to select the Shell option, wait for the shell prompt,
// then send the real command and collect its output.
// ---------------------------------------------------------------------------

function runOPNsenseSSH(cfg, command) {
  return new Promise(function (resolve, reject) {
    var conn   = new Client();
    var output = '';
    var stage  = 'menu'; // states: menu -> shell -> done

    // Timer so we never hang forever
    var timeout = setTimeout(function () {
      conn.end();
      reject(new Error('OPNsense SSH timeout'));
    }, 20000);

    conn.on('ready', function () {
      logger.debug('[OPNsense SSH] Connection ready, requesting PTY shell');

      conn.shell({ term: 'dumb', cols: 220, rows: 24 }, function (err, stream) {
        if (err) {
          clearTimeout(timeout);
          conn.end();
          return reject(err);
        }

        stream.on('data', function (data) {
          var chunk = data.toString();
          output += chunk;

          if (stage === 'menu') {
            // Wait for the menu option prompt.
            // OPNsense menu ends with something like "Enter an option: "
            if (/Enter an option/i.test(chunk) || /option.*:/i.test(chunk)) {
              stage = 'shell_wait';
              logger.debug('[OPNsense SSH] Menu detected, sending 8');
              stream.write('8\n');
            }
          } else if (stage === 'shell_wait') {
            // Wait for a real shell prompt (#, $, or %)
            if (/[#$%]\s*$/.test(chunk.trim())) {
              stage = 'cmd_wait';
              // Clear accumulated output (menu noise) and run our command.
              // We append a unique sentinel so we know when output ends.
              output = '';
              logger.debug('[OPNsense SSH] Shell ready, running command');
              stream.write(command + '; echo __OPNSENSE_DONE__\n');
            }
          } else if (stage === 'cmd_wait') {
            if (output.indexOf('__OPNSENSE_DONE__') !== -1) {
              // Strip the sentinel and everything after it, plus the command echo
              var result = output
                .replace(/\r/g, '')
                .split('__OPNSENSE_DONE__')[0]
                // Remove the echoed command line itself (first line)
                .replace(/^[^\n]*\n/, '')
                .trim();

              stage = 'done';
              clearTimeout(timeout);
              conn.end();
              resolve(result);
            }
          }
        });

        stream.stderr.on('data', function (d) {
          logger.debug('[OPNsense SSH] stderr: ' + d.toString().trim());
        });

        stream.on('close', function () {
          clearTimeout(timeout);
          if (stage !== 'done') {
            // Ended before we got a result
            conn.end();
            reject(new Error('OPNsense SSH stream closed before command completed (stage: ' + stage + ')'));
          }
        });
      });
    });

    conn.on('error', function (err) {
      clearTimeout(timeout);
      logger.error('[OPNsense SSH] Connection error: ' + err.message);
      reject(err);
    });

    conn.connect({
      host:          cfg.sshHost     || cfg.host,
      port:          cfg.sshPort     || 22,
      username:      cfg.sshUser     || 'root',
      password:      cfg.sshPassword || undefined,
      privateKey:    cfg.sshKeyPath  ? require('fs').readFileSync(cfg.sshKeyPath) : undefined,
      readyTimeout:  10000,
      hostVerifier:  function () { return true; },
    });
  });
}

// ---------------------------------------------------------------------------
// Reservation sources
// ---------------------------------------------------------------------------

/**
 * Source 1 - Kea DHCPv4 API (OPNsense >= 24.1 with Kea backend).
 * Returns null if the endpoint is not present.
 */
async function fetchReservationsKea(cfg) {
  try {
    var rows = await fetchAllRows(cfg, '/api/kea/dhcpv4/searchReservation');
    var map  = {};
    rows.forEach(function (row) {
      var mac = (row['hw-address'] || row.mac || '').toLowerCase();
      if (!mac) return;
      map[mac] = {
        ip:          row['ip-address'] || row.ipaddr || null,
        hostname:    row.hostname                    || null,
        description: row.description  || row.descr  || null,
      };
    });
    logger.info('[OPNsense] Kea reservations: ' + Object.keys(map).length + ' entry(ies)');
    return map;
  } catch (err) {
    logger.debug('[OPNsense] Kea reservation endpoint unavailable (' + err.message + '), trying config.xml via SSH');
    return null;
  }
}

/**
 * Source 2 - Parse /conf/config.xml via SSH (option 8 shell).
 * Works for ISC DHCP and Dnsmasq static host mappings.
 */
async function fetchReservationsConfigXml(cfg) {
  try {
    // We only need the <dhcpd> section; pipe through grep to limit data
    var xmlChunk = await runOPNsenseSSH(cfg, "cat /conf/config.xml");

    var map     = {};
    var blockRe = /<staticmap>([\s\S]*?)<\/staticmap>/g;
    var tagRe   = function (tag, text) {
      var m = new RegExp('<' + tag + '>([^<]*)<\\/' + tag + '>').exec(text);
      return m ? m[1].trim() : null;
    };

    var block;
    while ((block = blockRe.exec(xmlChunk)) !== null) {
      var inner = block[1];
      var mac   = (tagRe('mac', inner) || '').toLowerCase();
      if (!mac) continue;
      map[mac] = {
        ip:          tagRe('ipaddr',   inner),
        hostname:    tagRe('hostname', inner),
        description: tagRe('descr',   inner),
      };
    }

    logger.info('[OPNsense] config.xml static maps: ' + Object.keys(map).length + ' entry(ies)');
    return map;
  } catch (err) {
    logger.warn('[OPNsense] config.xml SSH fetch failed: ' + err.message);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

async function refresh(cfg) {
  try {
    // --- Dynamic leases (REST API, works for all backends) ---
    var leaseRows   = await fetchAllRows(cfg, '/api/dhcpv4/leases/searchLease');
    var newLeaseMap = {};
    leaseRows.forEach(function (row) {
      var mac = (row.mac || '').toLowerCase();
      if (!mac) return;
      newLeaseMap[mac] = {
        ip:       row.address  || null,
        hostname: row.hostname || null,
        ends:     row.ends     || null,
        type:     row.type     || null, // 'dynamic' or 'static'
      };
    });
    leaseMap = newLeaseMap;

    // --- Reservations: Kea API first, fall back to config.xml via SSH ---
    var newReservationMap = await fetchReservationsKea(cfg);
    if (newReservationMap === null) {
      newReservationMap = await fetchReservationsConfigXml(cfg);
    }
    reservationMap = newReservationMap || {};

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
