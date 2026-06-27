import { useState } from 'react';

const COLUMNS = [
  { key: 'mac',      label: 'MAC Address' },
  { key: 'vendor',   label: 'Vendor' },
  { key: 'hostname', label: 'Hostname' },
  { key: 'ip',       label: 'IP Address' },
  { key: 'apName',   label: 'Access Point' },
  { key: 'iface',    label: 'Interface' },
  { key: 'rssi',     label: 'RSSI (dBm)' },
  { key: 'tx_bytes', label: 'TX' },
  { key: 'rx_bytes', label: 'RX' },
];

function rssiColor(rssi) {
  if (rssi === null || rssi === undefined) return 'text-gray-500';
  if (rssi >= -60) return 'text-green-400';
  if (rssi >= -75) return 'text-yellow-400';
  return 'text-red-400';
}

function fmtBytes(val) {
  if (val === null || val === undefined) return null;
  const n = Number(val);
  if (isNaN(n)) return null;
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
  if (n >= 1048576)    return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024)       return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

/**
 * Convert an IPv4 string to a 32-bit integer for numeric comparison.
 * Returns null for anything that is not a valid dotted-quad address so
 * those rows sort to the end regardless of direction.
 */
function ipToInt(ip) {
  if (!ip) return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (octets.some(function(o) { return isNaN(o) || o < 0 || o > 255; })) return null;
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function VendorCell({ client }) {
  if (client.isMeshNode) {
    return (
      <span className="inline-flex items-center gap-1 bg-indigo-900/40 border border-indigo-700/50 text-indigo-300 text-xs rounded-full px-2 py-0.5 font-medium">
        <span className="text-indigo-400">&#9737;</span> Mesh Node
      </span>
    );
  }
  if (!client.vendor) return <span className="text-gray-600">n/a</span>;
  return <span className="text-gray-400">{client.vendor}</span>;
}

export default function ClientTable({ clients, disconnecting, onDisconnect }) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('apName');
  const [sortDir, setSortDir] = useState('asc');

  const filtered = clients.filter(function(c) {
    const q = search.toLowerCase();
    return (
      (c.mac && c.mac.toLowerCase().includes(q)) ||
      (c.vendor && c.vendor.toLowerCase().includes(q)) ||
      (c.hostname && c.hostname.toLowerCase().includes(q)) ||
      (c.ip && c.ip.toLowerCase().includes(q)) ||
      (c.apName && c.apName.toLowerCase().includes(q)) ||
      (c.isMeshNode && 'mesh node'.includes(q))
    );
  });

  const sorted = filtered.slice().sort(function(a, b) {
    var cmp = 0;
    if (sortKey === 'ip') {
      // Numeric octet-by-octet comparison; null IPs always sort last.
      const ai = ipToInt(a.ip);
      const bi = ipToInt(b.ip);
      if (ai === null && bi === null) cmp = 0;
      else if (ai === null) cmp = 1;
      else if (bi === null) cmp = -1;
      else cmp = ai < bi ? -1 : ai > bi ? 1 : 0;
    } else {
      const av = a[sortKey] != null ? a[sortKey] : '';
      const bv = b[sortKey] != null ? b[sortKey] : '';
      cmp = av < bv ? -1 : av > bv ? 1 : 0;
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir(function(d) { return d === 'asc' ? 'desc' : 'asc'; });
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  function sortMark(key) {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' (asc)' : ' (desc)';
  }

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-300">Connected Clients</h2>
        <input
          type="text"
          placeholder="Search MAC, vendor, hostname, IP, AP..."
          value={search}
          onChange={function(e) { setSearch(e.target.value); }}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 w-full sm:w-80"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-xs uppercase tracking-wider border-b border-gray-800">
              {COLUMNS.map(function(col) {
                return (
                  <th
                    key={col.key}
                    onClick={function() { toggleSort(col.key); }}
                    className="px-4 py-2 text-left cursor-pointer select-none hover:text-gray-300 transition-colors whitespace-nowrap"
                  >
                    {col.label}{sortMark(col.key)}
                  </th>
                );
              })}
              <th className="px-4 py-2 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="px-4 py-10 text-center text-gray-600">
                  {clients.length === 0 ? 'No clients connected.' : 'No results for your search.'}
                </td>
              </tr>
            )}
            {sorted.map(function(c) {
              const isKicking = !!disconnecting[c.mac];
              const txFmt = fmtBytes(c.tx_bytes);
              const rxFmt = fmtBytes(c.rx_bytes);
              return (
                <tr
                  key={c.mac}
                  className={
                    'border-b border-gray-800 last:border-0 transition-colors ' +
                    (c.isMeshNode ? 'bg-indigo-950/20 hover:bg-indigo-950/30' : 'hover:bg-gray-800/50')
                  }
                >
                  <td className="px-4 py-3 font-mono text-xs text-blue-300">{c.mac}</td>
                  <td className="px-4 py-3 text-xs">
                    <VendorCell client={c} />
                  </td>
                  <td className="px-4 py-3 text-gray-300">{c.hostname || <span className="text-gray-600">n/a</span>}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-400">{c.ip || <span className="text-gray-600">n/a</span>}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 bg-gray-800 border border-gray-700 rounded-full px-2.5 py-0.5 text-xs text-gray-300">
                      <span className={'w-1.5 h-1.5 rounded-full inline-block ' + (c.isMeshNode ? 'bg-indigo-400' : 'bg-green-400')}></span>
                      {c.apName}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{c.iface || 'n/a'}</td>
                  <td className={'px-4 py-3 font-mono text-xs ' + rssiColor(c.rssi)}>
                    {c.rssi != null ? c.rssi : <span className="text-gray-600">n/a</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-400">
                    {txFmt !== null ? txFmt : <span className="text-gray-600">n/a</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-400">
                    {rxFmt !== null ? rxFmt : <span className="text-gray-600">n/a</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {c.isMeshNode ? (
                      <span className="text-xs text-gray-600 px-3 py-1.5">Infrastructure</span>
                    ) : (
                      <button
                        onClick={function() { onDisconnect(c.mac); }}
                        disabled={isKicking}
                        className={
                          'text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ' +
                          (isKicking
                            ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
                            : 'bg-red-600/20 text-red-400 border border-red-600/30 hover:bg-red-600/40 hover:text-red-300')
                        }
                      >
                        {isKicking ? 'Disconnecting...' : 'Disconnect'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="px-4 py-2 border-t border-gray-800 text-xs text-gray-600">
        Showing {sorted.length} of {clients.length} client{clients.length !== 1 ? 's' : ''}
      </div>
    </div>
  );
}
