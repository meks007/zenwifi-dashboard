const { Client } = require('ssh2');
const logger = require('./logger');

function runSSH(ap, command) {
  return new Promise(function(resolve, reject) {
    const conn = new Client();
    let output = '';
    let stderrOut = '';

    logger.debug('[SSH] ' + ap.name + ' CMD: ' + command);

    conn.on('ready', function() {
      logger.debug('[SSH] ' + ap.name + ' connection ready');
      conn.exec(command, function(err, stream) {
        if (err) { conn.end(); return reject(err); }
        stream.on('data', function(data) { output += data.toString(); });
        stream.stderr.on('data', function(data) { stderrOut += data.toString(); });
        stream.on('close', function() {
          if (stderrOut.trim()) logger.debug('[SSH] ' + ap.name + ' stderr: ' + stderrOut.trim());
          conn.end();
          resolve(output);
        });
      });
    });

    conn.on('error', function(err) {
      logger.error('[SSH] ' + ap.name + ' (' + ap.host + ') connection error: ' + err.message);
      reject(err);
    });

    conn.connect({
      host: ap.host,
      port: ap.ssh_port || 22,
      username: ap.username,
      password: ap.password,
      readyTimeout: 10000,
      hostVerifier: function() { return true; },
    });
  });
}

async function getWirelessInterfaces(ap) {
  try {
    const out = await runSSH(ap, 'nvram get wl_ifnames 2>/dev/null || echo ""');
    const ifaces = out.trim().split(/\s+/).filter(Boolean);
    if (ifaces.length > 0) {
      logger.info('[SSH] ' + ap.name + ' interfaces from nvram: ' + ifaces.join(', '));
      return ifaces;
    }
    logger.warn('[SSH] ' + ap.name + ' no interfaces from nvram, falling back to [eth1, eth2, eth3]');
    return ['eth1', 'eth2', 'eth3'];
  } catch (err) {
    logger.warn('[SSH] ' + ap.name + ' interface discovery failed (' + err.message + '), using fallback');
    return ['eth1', 'eth2', 'eth3'];
  }
}

async function fetchClientsFromAP(ap) {
  const clients = [];

  logger.info('[SSH] Polling AP: ' + ap.name + ' at ' + ap.host + ':' + (ap.ssh_port || 22));

  try {
    const ifaces = await getWirelessInterfaces(ap);

    const arpOut = await runSSH(ap, 'cat /proc/net/arp 2>/dev/null || echo ""');
    const macToIp = {};
    const macToHostname = {};

    arpOut.split('\n').forEach(function(line) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4 && parts[3] && parts[3].includes(':')) {
        macToIp[parts[3].toLowerCase()] = parts[0];
      }
    });
    logger.debug('[SSH] ' + ap.name + ' ARP entries: ' + Object.keys(macToIp).length);

    try {
      const leaseOut = await runSSH(
        ap,
        'cat /var/lib/misc/dnsmasq.leases 2>/dev/null || cat /tmp/dnsmasq.leases 2>/dev/null || echo ""'
      );
      let leaseCount = 0;
      leaseOut.split('\n').forEach(function(line) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4) {
          const mac = parts[1].toLowerCase();
          const ip = parts[2];
          const hostname = parts[3] !== '*' ? parts[3] : null;
          if (mac.includes(':')) {
            if (ip && ip !== '0.0.0.0') macToIp[mac] = ip;
            if (hostname) { macToHostname[mac] = hostname; leaseCount++; }
          }
        }
      });
      logger.debug('[SSH] ' + ap.name + ' dnsmasq hostnames resolved: ' + leaseCount);
    } catch (leaseErr) {
      logger.warn('[SSH] ' + ap.name + ' dnsmasq leases unavailable: ' + leaseErr.message);
    }

    for (let i = 0; i < ifaces.length; i++) {
      const iface = ifaces[i];
      try {
        const assocOut = await runSSH(ap, 'wl -i ' + iface + ' assoclist 2>/dev/null || echo ""');
        const macs = assocOut
          .split('\n')
          .map(function(l) { return l.replace(/^assoclist\s+/i, '').trim().toLowerCase(); })
          .filter(function(m) { return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m); });

        logger.info('[SSH] ' + ap.name + ' iface ' + iface + ': ' + macs.length + ' client(s) associated');

        for (let j = 0; j < macs.length; j++) {
          const mac = macs[j];
          let rssi = null;
          try {
            const rssiOut = await runSSH(ap, 'wl -i ' + iface + ' rssi ' + mac + ' 2>/dev/null || echo ""');
            const rssiMatch = rssiOut.match(/-?\d+/);
            if (rssiMatch) rssi = parseInt(rssiMatch[0]);
          } catch (rssiErr) {
            logger.debug('[SSH] ' + ap.name + ' RSSI unavailable for ' + mac + ': ' + rssiErr.message);
          }

          clients.push({
            mac: mac,
            ip: macToIp[mac] || null,
            hostname: macToHostname[mac] || null,
            rssi: rssi,
            iface: iface,
            apName: ap.name,
            apHost: ap.host,
          });
        }
      } catch (ifaceErr) {
        logger.warn('[SSH] ' + ap.name + ' failed to query iface ' + iface + ': ' + ifaceErr.message);
      }
    }

    logger.info('[SSH] ' + ap.name + ' done: ' + clients.length + ' client(s) total');

  } catch (err) {
    logger.error('[SSH] Fatal error polling ' + ap.name + ': ' + err.message);
  }

  return clients;
}

async function disconnectClient(ap, mac) {
  logger.info('[SSH] Kicking client ' + mac + ' from AP ' + ap.name);
  const ifaces = await getWirelessInterfaces(ap);
  let kicked = false;
  for (let i = 0; i < ifaces.length; i++) {
    const iface = ifaces[i];
    try {
      await runSSH(ap, 'wl -i ' + iface + ' deauthenticate ' + mac + ' 2>/dev/null');
      logger.info('[SSH] ' + ap.name + ': deauthenticated ' + mac + ' on ' + iface);
      kicked = true;
    } catch (err) {
      logger.warn('[SSH] ' + ap.name + ': deauth on ' + iface + ' failed: ' + err.message);
    }
  }
  return kicked;
}

module.exports = { fetchClientsFromAP, disconnectClient };
