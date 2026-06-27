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

// Toggle a value in/out of a Set, returning a new Set.
function toggleSet(set, value) {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export default function ClientTable({ clients, disconnecting, onDisconnect }) {
  const [search, setSearch]     = useState('');
  // facets: exact-match filters for clickable columns.
  // Each key holds a Set of selected values; all active sets must match (AND).
  const [facetVendor, setFacetVendor] = useState(new Set());
  const [facetAp,     setFacetAp]     = useState(new Set());
  const [sortCols,    setSortCols]    = useState(DEFAULT_SORT);

  // ---- filtering ----
  const filtered = clients.filter(function(c) {
    // Text search
    if (search) {
      const q = search.toLowerCase();
      const textMatch =
        (c.mac      && c.mac.toLowerCase().includes(q))      ||
        (c.vendor   && c.vendor.toLowerCase().includes(q))   ||
        (c.hostname && c.hostname.toLowerCase().includes(q)) ||
        (c.ip       && c.ip.toLowerCase().includes(q))       ||
        (c.apName   && c.apName.toLowerCase().includes(q))   ||
        (c.isMeshNode && 'mesh node'.includes(q));
      if (!textMatch) return false;
    }
    // Facet: vendor
    if (facetVendor.size > 0) {
      const v = c.isMeshNode ? 'Mesh Node' : (c.vendor || '');
      if (!facetVendor.has(v)) return false;
    }
    // Facet: access point
    if (facetAp.size > 0) {
      if (!facetAp.has(c.apName || '')) return false;
    }
    return true;
  });

  // ---- sorting ----
  const sorted = filtered.slice().sort(function(a, b) {
    for (var i = 0; i < sortCols.length; i++) {
      const cmp = compareByKey(a, b, sortCols[i].key);
      if (cmp !== 0) return sortCols[i].dir === 'asc' ? cmp : -cmp;
    }
    return 0;
  });

  // ---- sort interaction ----
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

  function resetSort() { setSortCols(DEFAULT_SORT); }

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

  // ---- facet interaction ----
  function clickVendor(value) { setFacetVendor(function(prev) { return toggleSet(prev, value); }); }
  function clickAp(value)     { setFacetAp(function(prev)     { return toggleSet(prev, value); }); }

  const hasFilters = search || facetVendor.size > 0 || facetAp.size > 0;

  function resetFilters() {
    setSearch('');
    setFacetVendor(new Set());
    setFacetAp(new Set());
  }

  // ---- facet chip list ----
  const facetChips = [];
  facetVendor.forEach(function(v) {
    facetChips.push({ label: v, remove: function() { setFacetVendor(function(prev) { return toggleSet(prev, v); }); } });
  });
  facetAp.forEach(function(v) {
    facetChips.push({ label: v, remove: function() { setFacetAp(function(prev) { return toggleSet(prev, v); }); } });
  });

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
      {/* Header bar */}
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
          {/* Search field with X button */}
          <div className="relative flex items-center w-full sm:w-80">
            <input
              type="text"
              placeholder="Search MAC, vendor, hostname, IP, AP..."
              value={search}
              onChange={function(e) { setSearch(e.target.value); }}
              className="bg-gray-800 border border-gray-700 rounded-lg pl-3 pr-8 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 w-full"
            />
            {hasFilters && (
              <button
                onClick={resetFilters}
                className="absolute right-2 text-gray-500 hover:text-gray-200 transition-colors leading-none"
                title="Clear all filters"
              >
                &#10005;
              </button>
            )}
          </div>
        </div>
        {/* Active facet chips */}
        {facetChips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {facetChips.map(function(chip, i) {
              return (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 bg-blue-900/40 border border-blue-700/50 text-blue-300 text-xs rounded-full pl-2.5 pr-1.5 py-0.5"
                >
                  {chip.label}
                  <button
                    onClick={chip.remove}
                    className="text-blue-400 hover:text-white transition-colors leading-none ml-0.5"
                    title="Remove filter"
                  >
                    &#10005;
                  </button>
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

              // Vendor facet value (mesh nodes use "Mesh Node" as their vendor key)
              const vendorFacetValue = c.isMeshNode ? 'Mesh Node' : (c.vendor || '');
              const vendorActive = facetVendor.has(vendorFacetValue);
              const apActive     = facetAp.has(c.apName || '');

              return (
                <tr
                  key={c.mac}
                  className={
                    'border-b border-gray-800 last:border-0 transition-colors ' +
                    (c.isMeshNode ? 'bg-indigo-950/20 hover:bg-indigo-950/30' : 'hover:bg-gray-800/50')
                  }
                >
                  <td className="px-4 py-3 font-mono text-xs text-blue-300">{c.mac}</td>

                  {/* Vendor cell -- clickable */}
                  <td className="px-4 py-3 text-xs">
                    {c.isMeshNode ? (
                      <button
                        onClick={function() { clickVendor('Mesh Node'); }}
                        className={
                          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium border transition-colors cursor-pointer ' +
                          (vendorActive
                            ? 'bg-indigo-800/60 border-indigo-500 text-indigo-200'
                            : 'bg-indigo-900/40 border-indigo-700/50 text-indigo-300 hover:bg-indigo-800/50 hover:border-indigo-600')
                        }
                        title="Filter by Mesh Node"
                      >
                        <span className="text-indigo-400">&#9737;</span> Mesh Node
                      </button>
                    ) : c.vendor ? (
                      <button
                        onClick={function() { clickVendor(c.vendor); }}
                        className={
                          'rounded px-1.5 py-0.5 transition-colors cursor-pointer border ' +
                          (vendorActive
                            ? 'bg-blue-900/40 border-blue-600 text-blue-200'
                            : 'border-transparent text-gray-400 hover:bg-gray-800 hover:border-gray-600 hover:text-gray-200')
                        }
                        title={'Filter by ' + c.vendor}
                      >
                        {c.vendor}
                      </button>
                    ) : (
                      <span className="text-gray-600">n/a</span>
                    )}
                  </td>

                  <td className="px-4 py-3 text-gray-300">{c.hostname || <span className="text-gray-600">n/a</span>}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-400">{c.ip || <span className="text-gray-600">n/a</span>}</td>

                  {/* Access Point cell -- clickable */}
                  <td className="px-4 py-3">
                    <button
                      onClick={function() { clickAp(c.apName || ''); }}
                      className={
                        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs border transition-colors cursor-pointer ' +
                        (apActive
                          ? 'bg-blue-900/40 border-blue-600 text-blue-200'
                          : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700 hover:border-gray-500')
                      }
                      title={'Filter by ' + c.apName}
                    >
                      <span className={'w-1.5 h-1.5 rounded-full inline-block flex-shrink-0 ' + (c.isMeshNode ? 'bg-indigo-400' : 'bg-green-400')}></span>
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
