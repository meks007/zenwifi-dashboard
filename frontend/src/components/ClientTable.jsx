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

// Default sort applied on first load and when the user clicks "Reset sort".
const DEFAULT_SORT = [{ key: 'apName', dir: 'asc' }];

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
 * Convert an IPv4 string to an unsigned 32-bit integer for numeric comparison.
 * Returns null for anything that is not a valid dotted-quad so those rows
 * sort to the end regardless of direction.
 */
function ipToInt(ip) {
  if (!ip) return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (octets.some(function(o) { return isNaN(o) || o < 0 || o > 255; })) return null;
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

/**
 * Compare two client rows for a single sort column.
 * Returns a negative, zero, or positive number (direction flip is applied by caller).
 */
function compareByKey(a, b, key) {
  if (key === 'ip') {
    const ai = ipToInt(a.ip);
    const bi = ipToInt(b.ip);
    if (ai === null && bi === null) return 0;
    if (ai === null) return 1;
    if (bi === null) return -1;
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  }
  const av = a[key] != null ? a[key] : '';
  const bv = b[key] != null ? b[key] : '';
  return av < bv ? -1 : av > bv ? 1 : 0;
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
  // sortCols: ordered array of { key, dir }.
  // First entry is the primary sort; subsequent entries break ties left to right.
  const [sortCols, setSortCols] = useState(DEFAULT_SORT);

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
    for (var i = 0; i < sortCols.length; i++) {
      const cmp = compareByKey(a, b, sortCols[i].key);
      if (cmp !== 0) return sortCols[i].dir === 'asc' ? cmp : -cmp;
    }
    return 0;
  });

  /**
   * Plain click: make this the sole primary sort column (asc), or toggle its
   * direction if it is already the only active column.
   * Shift+click: add as an asc tie-breaker, or toggle its direction if already
   * in the list. Does not clear existing sort columns.
   */
  function toggleSort(key, event) {
    const shift = event && event.shiftKey;
    setSortCols(function(prev) {
      const existingIdx = prev.findIndex(function(s) { return s.key === key; });
      if (shift) {
        if (existingIdx === -1) {
          return prev.concat({ key: key, dir: 'asc' });
        }
        return prev.map(function(s, i) {
          return i === existingIdx ? { key: s.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : s;
        });
      }
      if (prev.length === 1 && prev[0].key === key) {
        return [{ key: key, dir: prev[0].dir === 'asc' ? 'desc' : 'asc' }];
      }
      return [{ key: key, dir: 'asc' }];
    });
  }

  function resetSort() {
    setSortCols(DEFAULT_SORT);
  }

  function sortMark(key) {
    const idx = sortCols.findIndex(function(s) { return s.key === key; });
    if (idx === -1) return null;
    const col = sortCols[idx];
    const arrow = col.dir === 'asc' ? ' \u2191' : ' \u2193';
    const badge = sortCols.length > 1
      ? <sup className="ml-0.5 text-blue-400 font-bold">{idx + 1}</sup>
      : null;
    return <span className="text-blue-400">{arrow}{badge}</span>;
  }

  const isDefaultSort =
    sortCols.length === DEFAULT_SORT.length &&
    sortCols.every(function(s, i) {
      return s.key === DEFAULT_SORT[i].key && s.dir === DEFAULT_SORT[i].dir;
    });

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-gray-300">Connected Clients</h2>
          {!isDefaultSort && (
            <button
              onClick={resetSort}
              className="text-xs px-2 py-0.5 rounded border border-gray-600 text-gray-400 hover:text-gray-200 hover:border-gray-400 transition-colors"
              title="Reset to default sort"
            >
              Reset sort
            </button>
          )}
        </div>
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
                const isActive = sortCols.some(function(s) { return s.key === col.key; });
                return (
                  <th
                    key={col.key}
                    onClick={function(e) { toggleSort(col.key, e); }}
                    className={
                      'px-4 py-2 text-left cursor-pointer select-none transition-colors whitespace-nowrap ' +
                      (isActive ? 'text-gray-300' : 'hover:text-gray-300')
                    }
                    title="Click to sort. Shift+click to add as tie-breaker."
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
