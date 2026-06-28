import { useState, useEffect, useRef } from 'react';

// Column definitions - order here is the default render order.
const DEFAULT_COLUMNS = [
  { id: 'mac',        label: 'MAC Address' },
  { id: 'vendor',     label: 'Vendor' },
  { id: 'hostname',   label: 'Hostname' },
  { id: 'ip',         label: 'IP Address' },
  { id: 'apName',     label: 'Access Point' },
  { id: 'iface',      label: 'Interface' },
  { id: 'rssi',       label: 'RSSI (dBm)' },
  { id: 'tx_bytes',   label: 'TX' },
  { id: 'rx_bytes',   label: 'RX' },
  { id: 'first_seen', label: 'First Seen' },
  { id: 'actions',    label: 'Actions' },
];

const LS_KEY = 'zenwifi_columns_v1';

function loadColumnPrefs() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return null;
    // Merge saved prefs with DEFAULT_COLUMNS so newly added columns appear at end.
    const savedMap = new Map(saved.map(function(c) { return [c.id, c]; }));
    const merged = DEFAULT_COLUMNS.map(function(def) {
      return savedMap.has(def.id)
        ? { id: def.id, label: def.label, visible: savedMap.get(def.id).visible }
        : { id: def.id, label: def.label, visible: true };
    });
    // Restore saved order for known columns; append any new ones at the end.
    const savedOrder = saved.map(function(c) { return c.id; }).filter(function(id) {
      return merged.some(function(m) { return m.id === id; });
    });
    const unsaved = merged.filter(function(m) { return !savedOrder.includes(m.id); });
    return savedOrder
      .map(function(id) { return merged.find(function(m) { return m.id === id; }); })
      .filter(Boolean)
      .concat(unsaved);
  } catch (_e) {
    return null;
  }
}

function saveColumnPrefs(cols) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(
      cols.map(function(c) { return { id: c.id, visible: c.visible }; })
    ));
  } catch (_e) {}
}

// Default sort: IP address ascending (numeric).
const DEFAULT_SORT = [{ key: 'ip', dir: 'asc' }];

// --- Helpers ---

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
  if (key === 'first_seen') {
    const at = a.first_seen ? new Date(a.first_seen).getTime() : Infinity;
    const bt = b.first_seen ? new Date(b.first_seen).getTime() : Infinity;
    return at < bt ? -1 : at > bt ? 1 : 0;
  }
  const av = a[key] != null ? String(a[key]).toLowerCase() : '';
  const bv = b[key] != null ? String(b[key]).toLowerCase() : '';
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function fmtRelative(isoStr) {
  if (!isoStr) return null;
  const diffMs = Date.now() - new Date(isoStr).getTime();
  if (diffMs < 0) return 'just now';
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  return d + 'd ago';
}

function fmtAbsolute(isoStr) {
  if (!isoStr) return '';
  return new Date(isoStr).toLocaleString();
}

// --- VendorCell ---

function VendorCell({ client, isMeshActive, activeVendors, activeOuis, onMeshClick, onVendorClick, onOuiClick }) {
  if (client.isMeshNode) {
    return (
      <button
        onClick={function(e) { e.stopPropagation(); onMeshClick(); }}
        title="Filter by Mesh Node"
        className={
          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium border transition-colors ' +
          (isMeshActive
            ? 'bg-indigo-800/60 border-indigo-500/70 text-indigo-200'
            : 'bg-indigo-900/40 border-indigo-700/50 text-indigo-300 hover:bg-indigo-800/50 hover:border-indigo-500/60')
        }
      >
        <span className="text-indigo-400">&#9737;</span> Mesh Node
      </button>
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

// --- ColumnSettingsPanel ---
// Popover for toggling column visibility and reordering via drag-and-drop.

function ColumnSettingsPanel({ columns, onChange, onClose }) {
  const dragIdx = useRef(null);
  const [localCols, setLocalCols] = useState(columns);

  // Propagate every local change up to the parent immediately.
  useEffect(function() {
    onChange(localCols);
  }, [localCols]);

  function toggleVisible(id) {
    setLocalCols(function(prev) {
      return prev.map(function(c) {
        return c.id === id ? Object.assign({}, c, { visible: !c.visible }) : c;
      });
    });
  }

  function onDragStart(e, idx) {
    dragIdx.current = idx;
    e.dataTransfer.effectAllowed = 'move';
  }

  function onDragOver(e, idx) {
    e.preventDefault();
    if (dragIdx.current === null || dragIdx.current === idx) return;
    setLocalCols(function(prev) {
      const next = prev.slice();
      const moved = next.splice(dragIdx.current, 1)[0];
      next.splice(idx, 0, moved);
      dragIdx.current = idx;
      return next;
    });
  }

  function onDragEnd() {
    dragIdx.current = null;
  }

  function resetToDefault() {
    setLocalCols(DEFAULT_COLUMNS.map(function(c) {
      return { id: c.id, label: c.label, visible: true };
    }));
  }

  return (
    <div className="absolute right-0 top-8 z-50 w-64 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-3 select-none">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Columns</span>
        <div className="flex gap-2 items-center">
          <button
            onClick={resetToDefault}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            title="Reset to default"
          >
            Reset
          </button>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-200 transition-colors text-base leading-none"
            title="Close"
          >
            &times;
          </button>
        </div>
      </div>
      <ul className="space-y-1">
        {localCols.map(function(col, idx) {
          return (
            <li
              key={col.id}
              draggable
              onDragStart={function(e) { onDragStart(e, idx); }}
              onDragOver={function(e) { onDragOver(e, idx); }}
              onDragEnd={onDragEnd}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-gray-800 cursor-grab active:cursor-grabbing group"
            >
              <span className="text-gray-600 group-hover:text-gray-400 transition-colors text-xs leading-none">::</span>
              <button
                onClick={function() { toggleVisible(col.id); }}
                className={
                  'w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ' +
                  (col.visible
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-gray-700 border-gray-600 text-transparent')
                }
                title={col.visible ? 'Hide column' : 'Show column'}
              >
                <svg viewBox="0 0 10 8" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 4l3 3 5-6"/>
                </svg>
              </button>
              <span className={'text-xs flex-1 ' + (col.visible ? 'text-gray-200' : 'text-gray-500')}>
                {col.label}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-gray-600 text-center">Drag rows to reorder</p>
    </div>
  );
}

// Sortable column ids - actions is intentionally excluded from sorting.
const SORTABLE = new Set(['mac', 'vendor', 'hostname', 'ip', 'apName', 'iface', 'rssi', 'tx_bytes', 'rx_bytes', 'first_seen']);

// --- ClientTable ---

export default function ClientTable({ clients, disconnecting, onDisconnect }) {
  const [search, setSearch] = useState('');
  const [sortCols, setSortCols] = useState(DEFAULT_SORT);
  const [activeAps, setActiveAps]         = useState(new Set());
  const [activeVendors, setActiveVendors] = useState(new Set());
  const [activeOuis, setActiveOuis]       = useState(new Set());
  const [meshOnly, setMeshOnly] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = useRef(null);

  // Column visibility and order - seeded from localStorage on first render.
  const [columns, setColumns] = useState(function() {
    const saved = loadColumnPrefs();
    if (saved) return saved;
    return DEFAULT_COLUMNS.map(function(c) {
      return { id: c.id, label: c.label, visible: true };
    });
  });

  // Persist column state whenever it changes.
  useEffect(function() {
    saveColumnPrefs(columns);
  }, [columns]);

  // Close the settings popover when clicking outside it.
  useEffect(function() {
    if (!showSettings) return;
    function handler(e) {
      if (settingsRef.current && !settingsRef.current.contains(e.target)) {
        setShowSettings(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return function() { document.removeEventListener('mousedown', handler); };
  }, [showSettings]);

  // Refresh relative timestamps every 30 seconds.
  const [, setTick] = useState(0);
  useEffect(function() {
    const id = setInterval(function() { setTick(function(n) { return n + 1; }); }, 30000);
    return function() { clearInterval(id); };
  }, []);

  const visibleCols = columns.filter(function(c) { return c.visible; });

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
    setMeshOnly(false);
  }

  const hasFilter = search.length > 0 || activeAps.size > 0 || activeVendors.size > 0 || activeOuis.size > 0 || meshOnly;

  const filtered = clients.filter(function(c) {
    if (meshOnly && !c.isMeshNode) return false;
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
  if (meshOnly) {
    chips.push({ label: 'Mesh Node', remove: function() { setMeshOnly(false); } });
  }
  activeOuis.forEach(function(v) {
    chips.push({ label: 'OUI: ' + v, remove: function() { toggleFacet(setActiveOuis, v); } });
  });
  activeVendors.forEach(function(v) {
    chips.push({ label: 'Vendor: ' + v, remove: function() { toggleFacet(setActiveVendors, v); } });
  });
  activeAps.forEach(function(v) {
    chips.push({ label: 'AP: ' + v, remove: function() { toggleFacet(setActiveAps, v); } });
  });

  // Render a single <td> for the given column id and client row.
  function renderCell(c, colId) {
    const isDiscovered = c.connectionType === 'discovered';
    const isMesh       = c.isMeshNode;
    const txFmt        = fmtBytes(c.tx_bytes);
    const rxFmt        = fmtBytes(c.rx_bytes);

    switch (colId) {
      case 'mac':
        return <td key="mac" className="px-4 py-3 font-mono text-xs text-blue-300">{c.mac}</td>;

      case 'vendor':
        return (
          <td key="vendor" className="px-4 py-3 text-xs text-left">
            <VendorCell
              client={c}
              isMeshActive={meshOnly}
              activeVendors={activeVendors}
              activeOuis={activeOuis}
              onMeshClick={function() { setMeshOnly(function(prev) { return !prev; }); }}
              onVendorClick={function(v) { toggleFacet(setActiveVendors, v); }}
              onOuiClick={function(v) { toggleFacet(setActiveOuis, v); }}
            />
          </td>
        );

      case 'hostname':
        return (
          <td key="hostname" className="px-4 py-3 text-gray-300">
            {c.hostname || <span className="text-gray-600">n/a</span>}
          </td>
        );

      case 'ip':
        return (
          <td key="ip" className="px-4 py-3 font-mono text-xs text-gray-400">
            {c.ip || <span className="text-gray-600">n/a</span>}
          </td>
        );

      case 'apName':
        return (
          <td key="apName" className="px-4 py-3 text-left">
            <button
              onClick={function() { toggleFacet(setActiveAps, c.apName); }}
              title={'Filter by AP: ' + c.apName}
              className="inline-flex items-center gap-1.5 bg-gray-800 border border-gray-700 rounded-full px-2.5 py-0.5 text-xs transition-colors cursor-pointer select-none hover:border-blue-600/40 hover:text-blue-300 text-gray-300 text-left"
              style={activeAps.has(c.apName) ? { background: 'rgba(30,58,138,0.3)', borderColor: 'rgba(37,99,235,0.5)', color: 'rgb(147,197,253)' } : {}}
            >
              <span className={
                'w-1.5 h-1.5 rounded-full flex-shrink-0 ' +
                (isMesh ? 'bg-indigo-400' : isDiscovered ? 'bg-amber-400' : 'bg-green-400')
              }></span>
              {c.apName}
            </button>
          </td>
        );

      case 'iface':
        return (
          <td key="iface" className="px-4 py-3 font-mono text-xs text-gray-500">
            {c.iface || 'n/a'}
          </td>
        );

      case 'rssi':
        return (
          <td key="rssi" className={'px-4 py-3 font-mono text-xs ' + rssiColor(c.rssi)}>
            {c.rssi != null ? c.rssi : <span className="text-gray-600">n/a</span>}
          </td>
        );

      case 'tx_bytes':
        return (
          <td key="tx_bytes" className="px-4 py-3 font-mono text-xs text-gray-400">
            {txFmt !== null ? txFmt : <span className="text-gray-600">n/a</span>}
          </td>
        );

      case 'rx_bytes':
        return (
          <td key="rx_bytes" className="px-4 py-3 font-mono text-xs text-gray-400">
            {rxFmt !== null ? rxFmt : <span className="text-gray-600">n/a</span>}
          </td>
        );

      case 'first_seen':
        return (
          <td key="first_seen" className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap" title={fmtAbsolute(c.first_seen)}>
            {c.first_seen ? fmtRelative(c.first_seen) : <span className="text-gray-600">n/a</span>}
          </td>
        );

      case 'actions':
        return (
          <td key="actions" className="px-4 py-3 text-right">
            {isMesh ? (
              <span className="text-xs text-gray-600 px-3 py-1.5">Infrastructure</span>
            ) : isDiscovered ? (
              <span className="text-xs text-gray-600 px-3 py-1.5">Discovered</span>
            ) : (
              <button
                onClick={function() { onDisconnect(c.mac); }}
                disabled={!!disconnecting[c.mac]}
                className={
                  'text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ' +
                  (disconnecting[c.mac]
                    ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
                    : 'bg-red-600/20 text-red-400 border border-red-600/30 hover:bg-red-600/40 hover:text-red-300')
                }
              >
                {disconnecting[c.mac] ? 'Disconnecting...' : 'Disconnect'}
              </button>
            )}
          </td>
        );

      default:
        return <td key={colId} className="px-4 py-3 text-gray-600">-</td>;
    }
  }

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
          <div className="flex items-center gap-2">
            {/* Column settings trigger */}
            <div className="relative" ref={settingsRef}>
              <button
                onClick={function() { setShowSettings(function(v) { return !v; }); }}
                title="Configure columns"
                className={
                  'p-1.5 rounded-lg border transition-colors ' +
                  (showSettings
                    ? 'bg-blue-900/40 border-blue-600/50 text-blue-300'
                    : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500')
                }
              >
                <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="1" y="2" width="4" height="12" rx="0.5"/>
                  <rect x="6" y="2" width="4" height="12" rx="0.5"/>
                  <rect x="11" y="2" width="4" height="12" rx="0.5"/>
                </svg>
              </button>
              {showSettings && (
                <ColumnSettingsPanel
                  columns={columns}
                  onChange={setColumns}
                  onClose={function() { setShowSettings(false); }}
                />
              )}
            </div>
            {/* Search input */}
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
              {visibleCols.map(function(col) {
                const sortable = SORTABLE.has(col.id);
                const isActive = sortable && sortCols.some(function(s) { return s.key === col.id; });
                const isActionsCol = col.id === 'actions';
                return (
                  <th
                    key={col.id}
                    onClick={sortable ? function(e) { toggleSort(col.id, e); } : undefined}
                    className={
                      'px-4 py-2 select-none transition-colors whitespace-nowrap ' +
                      (isActionsCol ? 'text-right ' : 'text-left ') +
                      (sortable ? 'cursor-pointer ' : '') +
                      (isActive ? 'text-gray-300' : sortable ? 'hover:text-gray-300' : '')
                    }
                    title={sortable ? 'Click to cycle asc/desc/off. Shift+click to remove from sort.' : undefined}
                  >
                    {col.label}{sortable ? sortMark(col.id) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={visibleCols.length} className="px-4 py-10 text-center text-gray-600">
                  {clients.length === 0 ? 'No clients connected.' : 'No results for your search.'}
                </td>
              </tr>
            )}
            {sorted.map(function(c) {
              const isMesh       = c.isMeshNode;
              const isDiscovered = c.connectionType === 'discovered';
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
                  {visibleCols.map(function(col) { return renderCell(c, col.id); })}
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
