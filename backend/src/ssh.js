const { Client } = require('ssh2');

/**
 * Run a command on a remote AP via SSH and return stdout as string.
 */
function runSSH(ap, command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }
        stream.on('data', (data) => { output += data.toString(); });
        stream.stderr.on('data', () => {});
        stream.on('close', () => {
          conn.end();
          resolve(output);
        });
      });
    });

    conn.on('error', (err) => reject(err));

    conn.connect({
      host: ap.host,
      port: ap.ssh_port || 22,
      username: ap.username,
      password: ap.password,
      readyTimeout: 10000,
      hostVerifier: () => true,
    });
  });
}

/**
 * Get list of wireless interfaces on the AP.
 * Returns array like ['eth1', 'eth2', 'eth3']
 */
async function getWirelessInterfaces(ap) {
  try {
    const out = await runSSH(ap, 'nvram get wl_ifnames 2>/dev/null || echo ""');
    const ifaces = out.trim().split(/\s+/).filter(Boolean);
    if (ifaces.length > 0) return ifaces;
    return ['eth1', 'eth2', 'eth3'];
  } catch {
    return ['eth1', 'eth2', 'eth3'];
  }
}

/**
 * Fetch all connected wireless clients from an AP.
 * Returns array of { mac, ip, hostname, rssi, iface, apName, apHost }
 */
async function fetchClientsFromAP(ap) {
  const clients = [];

  try {
    const ifaces = await getWirelessInterfaces(ap);

    // Build a MAC -> IP map from ARP table
    const arpOut = await runSSH(ap, 'cat /proc/net/arp 2>/dev/null || echo ""');
    const macToIp = {};
    const macToHostname = {};

    arpOut.split('\n').forEach((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4 && parts[3] && parts[3].includes(':')) {
        const ip = parts[0];
        const mac = parts[3].toLowerCase();
        macToIp[mac] = ip;
      }
    });

    // Get hostnames from dnsmasq lease file
    try {
      const leaseOut = await runSSH(
        ap,
        'cat /var/lib/misc/dnsmasq.leases 2>/dev/null || cat /tmp/dnsmasq.leases 2>/dev/null || echo ""'
      );
      leaseOut.split('\n').forEach((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4) {
          const mac = parts[1].toLowerCase();
          const ip = parts[2];
          const hostname = parts[3] !== '*' ? parts[3] : null;
          if (mac.includes(':')) {
            if (ip && ip !== '0.0.0.0') macToIp[mac] = ip;
            if (hostname) macToHostname[mac] = hostname;
          }
        }
      });
    } catch {}

    // For each wireless interface, get associated clients
    for (const iface of ifaces) {
      try {
        const assocOut = await runSSH(ap, `wl -i ${iface} assoclist 2>/dev/null || echo ""`);
        const macs = assocOut
          .split('\n')
          .map((l) => l.replace(/^assoclist\s+/i, '').trim().toLowerCase())
          .filter((m) => m.match(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/));

        for (const mac of macs) {
          let rssi = null;
          try {
            const rssiOut = await runSSH(ap, `wl -i ${iface} rssi ${mac} 2>/dev/null || echo ""`);
            const rssiMatch = rssiOut.match(/-?\d+/);
            if (rssiMatch) rssi = parseInt(rssiMatch[0]);
          } catch {}

          clients.push({
            mac,
            ip: macToIp[mac] || null,
            hostname: macToHostname[mac] || null,
            rssi,
            iface,
            apName: ap.name,
            apHost: ap.host,
          });
        }
      } catch {}
    }
  } catch (err) {
    console.error(`[SSH] Error polling AP ${ap.name} (${ap.host}):`, err.message);
  }

  return clients;
}

/**
 * Disconnect/kick a client from an AP across all wireless interfaces.
 */
async function disconnectClient(ap, mac) {
  const ifaces = await getWirelessInterfaces(ap);
  let kicked = false;
  for (const iface of ifaces) {
    try {
      await runSSH(ap, `wl -i ${iface} deauthenticate ${mac} 2>/dev/null`);
      kicked = true;
    } catch {}
  }
  return kicked;
}

module.exports = { fetchClientsFromAP, disconnectClient };
