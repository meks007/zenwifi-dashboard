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

// Default sort: IP address ascending (numeric).
const DEFAULT_SORT = [{ key: 'ip', dir: 'asc' }];

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

function macOui(mac) {
  if (!mac) return null;
  const parts = mac.split(':');
  if (parts.length < 3) return null;
  return (parts[0] + ':' + parts[1] + ':' + parts[2]).toUpperCase();
}

function ipToInt(ip) {
  if (!ip) return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (octets.some(function(o) { return isNaN(o) || o < 0 || o > 255; })) return null;
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function compareByKey(a, b, key) {
  if (key === 'ip') {
    const ai = ipToInt(a.ip);
    const bi = ipToInt(b.ip);
    if (ai === null && bi === null) return 0;
    if (ai === null) return 1;
    if (bi === null) return -1;
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  }
  const av = a[key] != null ? String(a[key]).toLowerCase() : '';
  const bv = b[key] != null ? String(b[key]).toLowerCase() : '';
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/**
 * Vendor column cell.
 * Mesh nodes show the Mesh Node badge only.
 * All other clients (Wi-Fi and discovered) show OUI chip + vendor name.
 * Discovered clients carry no extra badge here; the Access Point column
 * already labels them as "Discovered <Interface>".
 */
function VendorCell({ client, activeVendors, activeOuis, onVendorClick, onOuiClick }) {
  if (client.isMeshNode) {
    return (
      <span className="inline-flex items-center gap-1 bg-indigo-900/40 border border-indigo-700/50 text-indigo-300 text-xs rounded-full px-2 py-0.5 font-medium">
        <span className="text-indigo-400">&#9737;</span> Mesh Node
      </span>
    );
  }

  const oui = macOui(client.mac);
  const ouiActive = oui && activeOuis.has(oui);
  const vendorActive = client.vendor && activeVendors.has(client.vendor);
  return (
    <span className="inline-flex items-center gap-1.5">
      {oui && (
        <button
          onClick={function(e) { e.stopPropagation(); onOuiClick(oui); }}
          title={'Filter by OUI: ' + oui}
          className={
            'font-mono text-xs rounded px-1 py-0.5 border transition-colors ' +
            (ouiActive
              ? 'bg-blue-900/50 border-blue-600/60 text-blue-300'
              : 'bg-gray-800 border-gray-700 text-gray-500 hover:border-blue-600/40 hover:text-blue-400')
          }
        >
          {oui}
        </button>
      )}
      {client.vendor ? (
        <button
          onClick={function(e) { e.stopPropagation(); onVendorClick(client.vendor); }}
          title={'Filter by vendor: ' + client.vendor}
          className={
            'text-xs text-left transition-colors ' +
            (vendorActive ? 'text-blue-300' : 'text-gray-400 hover:text-blue-300')
          }
        >
          {client.vendor}
        </button>
      ) : (
        <span className="text-gray-600">n/a</span>
      )}
    </span>
  );
}

export default function ClientTable({ clients, disconnecting, onDisconnect }) {
  const [search, setSearch] = useState('');
  const [sortCols, setSortCols] = useState(DEFAULT_SORT);
  const [activeAps, setActiveAps]         = useState(new Set());
  const [activeVendors, setActiveVendors] = useState(new Set());
  const [activeOuis, setActiveOuis]       = useState(new Set());

  function toggleFacet(setter, value) {
    setter(function(prev) {
      const next = new Set(prev);
      if (next.has(value)) { next.delete(value); } else { next.add(value); }
      return next;
    });
  }

  function clearAll() {
    setSearch('');
    setActiveAps(new Set());
    setActiveVendors(new Set());
    setActiveOuis(new Set());
  }

  const hasFilter = search.length > 0 || activeAps.size > 0 || activeVendors.size > 0 || activeOuis.size > 0;

  const filtered = clients.filter(function(c) {
    if (search) {
      const q = search.toLowerCase();
      const textMatch = (
        (c.mac && c.mac.toLowerCase().includes(q)) ||
        (c.vendor && c.vendor.toLowerCase().includes(q)) ||
        (c.hostname && c.hostname.toLowerCase().includes(q)) ||
        (c.ip && c.ip.toLowerCase().includes(q)) ||
        (c.apName && c.apName.toLowerCase().includes(q)) ||
        (c.isMeshNode && 'mesh node'.includes(q)) ||
        (c.connectionType === 'discovered' && 'discovered'.includes(q))
      );
      if (!textMatch) return false;
    }
    if (activeAps.size > 0 && !activeAps.has(c.apName)) return false;
    if (activeVendors.size > 0 && !activeVendors.has(c.vendor)) return false;
    if (activeOuis.size > 0 && !activeOuis.has(macOui(c.mac))) return false;
    return true;
  });

  const sorted = filtered.slice().sort(function(a, b) {
    for (var i = 0; i < sortCols.length; i++) {
      const cmp = compareByKey(a, b, sortCols[i].key);
      if (cmp !== 0) return sortCols[i].dir === 'asc' ? cmp : -cmp;
    }
    return 0;
  });

  function toggleSort(key, event) {
    const shift = event && event.shiftKey;
    setSortCols(function(prev) {
      const existingIdx = prev.findIndex(function(s) { return s.key === key; });
      if (shift) {
        return prev.filter(function(s) { return s.key !== key; });
      }
      if (existingIdx === -1) {
        return prev.concat({ key: key, dir: 'asc' });
      }
      const current = prev[existingIdx];
      if (current.dir === 'asc') {
        return prev.map(function(s, i) {
          return i === existingIdx ? { key: s.key, dir: 'desc' } : s;
        });
      }
      return prev.filter(function(s) { return s.key !== key; });
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

  const chips = [];
  activeOuis.forEach(function(v) {
    chips.push({ label: 'OUI: ' + v, remove: function() { toggleFacet(setActiveOuis, v); } });
  });
  activeVendors.forEach(function(v) {
    chips.push({ label: 'Vendor: ' + v, remove: function() { toggleFacet(setActiveVendors, v); } });
  });
  activeAps.forEach(function(v) {
    chips.push({ label: 'AP: ' + v, remove: function() { toggleFacet(setActiveAps, v); } });
  });

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800 flex flex-col gap-2">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
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
          <div className="relative flex items-center sm:w-80">
            <input
              type="text"
              placeholder="Search MAC, vendor, hostname, IP, AP..."
              value={search}
              onChange={function(e) { setSearch(e.target.value); }}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 w-full pr-8"
            />
            {hasFilter && (
              <button
                onClick={clearAll}
                title="Clear all filters"
                className="absolute right-2 text-gray-500 hover:text-gray-200 transition-colors text-base leading-none"
              >
                &times;
              </button>
            )}
          </div>
        </div>
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {chips.map(function(chip, i) {
              return (
                <span key={i} className="inline-flex items-center gap-1 bg-blue-900/30 border border-blue-700/40 text-blue-300 text-xs rounded-full px-2 py-0.5">
                  {chip.label}
                  <button onClick={chip.remove} className="ml-0.5 text-blue-400 hover:text-white transition-colors leading-none">&times;</button>
                </span>
              );
            })}
          </div>
        )}
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
                    title="Click to cycle asc/desc/off. Shift+click to remove from sort."
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
              const isDiscovered = c.connectionType === 'discovered';
              const isMesh       = c.isMeshNode;
              return (
                <tr
                  key={c.mac}
                  className={
                    'border-b border-gray-800 last:border-0 transition-colors ' +
                    (isMesh       ? 'bg-indigo-950/20 hover:bg-indigo-950/30' :
                     isDiscovered ? 'bg-amber-950/10 hover:bg-amber-950/20'   :
                                    'hover:bg-gray-800/50')
                  }
                >
                  <td className="px-4 py-3 font-mono text-xs text-blue-300">{c.mac}</td>
                  <td className="px-4 py-3 text-xs text-left">
                    <VendorCell
                      client={c}
                      activeVendors={activeVendors}
                      activeOuis={activeOuis}
                      onVendorClick={function(v) { toggleFacet(setActiveVendors, v); }}
                      onOuiClick={function(v) { toggleFacet(setActiveOuis, v); }}
                    />
                  </td>
                  <td className="px-4 py-3 text-gray-300">{c.hostname || <span className="text-gray-600">n/a</span>}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-400">{c.ip || <span className="text-gray-600">n/a</span>}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={function() { toggleFacet(setActiveAps, c.apName); }}
                      title={'Filter by AP: ' + c.apName}
                      className="inline-flex items-center justify-start gap-1.5 bg-gray-800 border border-gray-700 rounded-full px-2.5 py-0.5 text-xs transition-colors cursor-pointer select-none hover:border-blue-600/40 hover:text-blue-300 text-gray-300"
                      style={activeAps.has(c.apName) ? { background: 'rgba(30,58,138,0.3)', borderColor: 'rgba(37,99,235,0.5)', color: 'rgb(147,197,253)' } : {}}
                    >
                      <span className={
                        'w-1.5 h-1.5 rounded-full inline-block flex-shrink-0 ' +
                        (isMesh ? 'bg-indigo-400' : isDiscovered ? 'bg-amber-400' : 'bg-green-400')
                      }></span>
                      {c.apName}
                    </button>
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
                    {isMesh ? (
                      <span className="text-xs text-gray-600 px-3 py-1.5">Infrastructure</span>
                    ) : isDiscovered ? (
                      <span className="text-xs text-gray-600 px-3 py-1.5">Discovered</span>
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
