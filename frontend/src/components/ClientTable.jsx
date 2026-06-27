import { useState } from 'react';

const COLUMNS = [
  { key: 'mac',            label: 'MAC Address' },
  { key: 'vendor',         label: 'Vendor' },
  { key: 'hostname',       label: 'Hostname' },
  { key: 'ip',             label: 'IP Address' },
  { key: 'apName',         label: 'Access Point' },
  { key: 'iface',          label: 'Interface' },
  { key: 'rssi',           label: 'RSSI (dBm)' },
  { key: 'tx_bytes',       label: 'TX' },
  { key: 'rx_bytes',       label: 'RX' },
];

// Default sort applied on first load and when the user clicks "Reset sort".
const DEFAULT_SORT = [{ key: 'apName', dir: 'asc' }];

// Connection type filter options shown as toggle chips above the table.
const CONNECTION_TYPE_FILTERS = [
  { value: 'all',   label: 'All' },
  { value: 'wifi',  label: 'Wi-Fi' },
  { value: 'wired', label: 'Wired' },
  { value: 'mesh',  label: 'Mesh' },
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
 * Extract the OUI prefix (first 3 octets, uppercase) from a MAC string.
 * Returns null for invalid MACs.
 */
function macOui(mac) {
  if (!mac) return null;
  const parts = mac.split(':');
  if (parts.length < 3) return null;
  return (parts[0] + ':' + parts[1] + ':' + parts[2]).toUpperCase();
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
 * Case-insensitive for string values.
 * Returns a negative, zero, or positive number (direction flip applied by caller).
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
  const av = a[key] != null ? String(a[key]).toLowerCase() : '';
  const bv = b[key] != null ? String(b[key]).toLowerCase() : '';
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/**
 * Badge shown in the Vendor column to identify the connection type of a client.
 * Mesh nodes get their existing indigo badge; wired clients get an amber badge.
 */
function ConnectionTypeBadge({ client }) {
  if (client.isMeshNode || client.connectionType === 'mesh') {
    return (
      <span className="inline-flex items-center gap-1 bg-indigo-900/40 border border-indigo-700/50 text-indigo-300 text-xs rounded-full px-2 py-0.5 font-medium">
        <span className="text-indigo-400">&#9737;</span> Mesh Node
      </span>
    );
  }
  if (client.connectionType === 'wired') {
    return (
      <span className="inline-flex items-center gap-1 bg-amber-900/40 border border-amber-700/50 text-amber-300 text-xs rounded-full px-2 py-0.5 font-medium">
        <span className="text-amber-400">&#9135;</span> Wired
      </span>
    );
  }
  return null;
}

function VendorCell({ client, activeVendors, activeOuis, onVendorClick, onOuiClick }) {
  if (client.isMeshNode || client.connectionType === 'mesh') {
    return <ConnectionTypeBadge client={client} />;
  }

  const oui = macOui(client.mac);
  const ouiActive = oui && activeOuis.has(oui);
  const vendorActive = client.vendor && activeVendors.has(client.vendor);

  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      {client.connectionType === 'wired' && <ConnectionTypeBadge client={client} />}
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
  // sortCols: ordered array of { key, dir }.
  // Index 0 is the primary sort; subsequent entries break ties left to right.
  // A column absent from this array contributes nothing to the sort order.
  const [sortCols, setSortCols] = useState(DEFAULT_SORT);

  // Facet filter sets: multiple values within a facet are ORed;
  // multiple facets are ANDed.
  const [activeAps, setActiveAps]         = useState(new Set());
  const [activeVendors, setActiveVendors] = useState(new Set());
  const [activeOuis, setActiveOuis]       = useState(new Set());

  // Single-select connection type filter. 'all' means no filtering.
  const [connectionTypeFilter, setConnectionTypeFilter] = useState('all');

  // Detect whether any wired clients exist in the current client list so we
  // only show the connection type toggles when relevant.
  const hasWiredClients = clients.some(function(c) { return c.connectionType === 'wired'; });

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
    setConnectionTypeFilter('all');
  }

  const hasFilter = (
    search.length > 0 ||
    activeAps.size > 0 ||
    activeVendors.size > 0 ||
    activeOuis.size > 0 ||
    connectionTypeFilter !== 'all'
  );

  const filtered = clients.filter(function(c) {
    // Connection type filter
    if (connectionTypeFilter !== 'all') {
      const ct = c.connectionType || (c.isMeshNode ? 'mesh' : 'wifi');
      if (ct !== connectionTypeFilter) return false;
    }
    // Text search
    if (search) {
      const q = search.toLowerCase();
      const textMatch = (
        (c.mac && c.mac.toLowerCase().includes(q)) ||
        (c.vendor && c.vendor.toLowerCase().includes(q)) ||
        (c.hostname && c.hostname.toLowerCase().includes(q)) ||
        (c.ip && c.ip.toLowerCase().includes(q)) ||
        (c.apName && c.apName.toLowerCase().includes(q)) ||
        (c.isMeshNode && 'mesh node'.includes(q)) ||
        (c.connectionType === 'wired' && 'wired'.includes(q))
      );
      if (!textMatch) return false;
    }
    // AP facet
    if (activeAps.size > 0 && !activeAps.has(c.apName)) return false;
    // Vendor facet
    if (activeVendors.size > 0 && !activeVendors.has(c.vendor)) return false;
    // OUI facet
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

  /**
   * Click cycles the column through: off -> asc -> desc -> off -> ...
   *   If the column is not yet in the list it is appended as asc.
   *   asc  -> desc  (update in place, preserving position)
   *   desc -> off   (remove from list)
   *
   * Shift+click removes the column from the list immediately (unsort).
   */
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

  // Chip list for active facets
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

        {/* Connection type toggle - only shown when wired clients are present */}
        {hasWiredClients && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-600 mr-1">Type:</span>
            {CONNECTION_TYPE_FILTERS.map(function(f) {
              const isActive = connectionTypeFilter === f.value;
              return (
                <button
                  key={f.value}
                  onClick={function() {
                    setConnectionTypeFilter(isActive ? 'all' : f.value);
                  }}
                  className={
                    'text-xs px-2.5 py-0.5 rounded-full border transition-colors ' +
                    (isActive
                      ? 'bg-blue-900/50 border-blue-600/60 text-blue-300'
                      : 'bg-gray-800 border-gray-700 text-gray-500 hover:border-blue-600/40 hover:text-blue-300')
                  }
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        )}

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
              const isWired    = c.connectionType === 'wired';
              const isMesh     = c.isMeshNode || c.connectionType === 'mesh';

              return (
                <tr
                  key={c.mac}
                  className={
                    'border-b border-gray-800 last:border-0 transition-colors ' +
                    (isMesh  ? 'bg-indigo-950/20 hover:bg-indigo-950/30' :
                     isWired ? 'bg-amber-950/10 hover:bg-amber-950/20'   :
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
                      className="inline-flex items-center gap-1.5 bg-gray-800 border border-gray-700 rounded-full px-2.5 py-0.5 text-xs transition-colors cursor-pointer select-none hover:border-blue-600/40 hover:text-blue-300 text-gray-300"
                      style={activeAps.has(c.apName) ? { background: 'rgba(30,58,138,0.3)', borderColor: 'rgba(37,99,235,0.5)', color: 'rgb(147,197,253)' } : {}}
                    >
                      <span className={
                        'w-1.5 h-1.5 rounded-full inline-block ' +
                        (isMesh ? 'bg-indigo-400' : isWired ? 'bg-amber-400' : 'bg-green-400')
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
                    ) : isWired ? (
                      <span className="text-xs text-gray-600 px-3 py-1.5">Wired</span>
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
