import { useState, useEffect, useRef } from 'react';

// ---- Column definitions ----
// defaultWidth in px. mobileVisible controls which columns show on narrow screens.
const DEFAULT_COLUMNS = [
  { id: 'mac',        label: 'MAC Address',  defaultWidth: 140, mobileVisible: true  },
  { id: 'vendor',     label: 'Vendor',       defaultWidth: 200, mobileVisible: false },
  { id: 'hostname',   label: 'Hostname',     defaultWidth: 160, mobileVisible: true  },
  { id: 'ip',         label: 'IP Address',   defaultWidth: 120, mobileVisible: true  },
  { id: 'apName',     label: 'Access Point', defaultWidth: 160, mobileVisible: false },
  { id: 'iface',      label: 'Interface',    defaultWidth: 90,  mobileVisible: false },
  { id: 'rssi',       label: 'RSSI (dBm)',   defaultWidth: 90,  mobileVisible: true  },
  { id: 'tx_bytes',   label: 'TX',           defaultWidth: 80,  mobileVisible: false },
  { id: 'rx_bytes',   label: 'RX',           defaultWidth: 80,  mobileVisible: false },
  { id: 'first_seen', label: 'First Seen',   defaultWidth: 100, mobileVisible: false },
  { id: 'actions',    label: 'Actions',      defaultWidth: 120, mobileVisible: true  },
];

const LS_COLS_KEY   = 'zenwifi_columns_v1';
const LS_WIDTHS_KEY = 'zenwifi_col_widths_v1';
const LS_SORT_KEY   = 'zenwifi_sort_v1';
const MOBILE_BP     = 640; // px, matches Tailwind sm:

// matchMedia singleton -- avoids spurious breakpoint flips caused by mobile
// browser chrome reflows (address bar, keyboard). The CSS engine drives this,
// so it always agrees with what Tailwind's sm: breakpoint sees.
var _mq = null;
function getMq() {
  if (!_mq && typeof window !== 'undefined') {
    _mq = window.matchMedia('(max-width: ' + (MOBILE_BP - 1) + 'px)');
  }
  return _mq;
}

function loadColumnPrefs() {
  try {
    const raw = localStorage.getItem(LS_COLS_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return null;
    const savedMap = new Map(saved.map(function(c) { return [c.id, c]; }));
    const merged = DEFAULT_COLUMNS.map(function(def) {
      const s = savedMap.get(def.id);
      if (!s) return { id: def.id, label: def.label, defaultWidth: def.defaultWidth, visible: true, mobileVisible: def.mobileVisible };
      return {
        id:            def.id,
        label:         def.label,
        defaultWidth:  def.defaultWidth,
        visible:       s.visible !== undefined       ? s.visible       : true,
        mobileVisible: s.mobileVisible !== undefined ? s.mobileVisible : def.mobileVisible,
      };
    });
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
    localStorage.setItem(LS_COLS_KEY, JSON.stringify(
      cols.map(function(c) { return { id: c.id, visible: c.visible, mobileVisible: c.mobileVisible }; })
    ));
  } catch (_e) {}
}

function loadWidthPrefs() {
  try {
    const raw = localStorage.getItem(LS_WIDTHS_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch (_e) { return {}; }
}

function saveWidthPrefs(widths) {
  try { localStorage.setItem(LS_WIDTHS_KEY, JSON.stringify(widths)); } catch (_e) {}
}

function loadSortPrefs() {
  try {
    const raw = localStorage.getItem(LS_SORT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed;
  } catch (_e) { return null; }
}

function saveSortPrefs(sortCols) {
  try { localStorage.setItem(LS_SORT_KEY, JSON.stringify(sortCols)); } catch (_e) {}
}

const DEFAULT_SORT  = [{ key: 'ip', dir: 'asc' }];
const MIN_COL_WIDTH = 50;

// ---- Helpers ----
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
    const ai = ipToInt(a.ip), bi = ipToInt(b.ip);
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

// ---- VendorCell ----
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
  const oui          = macOui(client.mac);
  const ouiActive    = oui && activeOuis.has(oui);
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
          className={'text-xs text-left transition-colors ' + (vendorActive ? 'text-blue-300' : 'text-gray-400 hover:text-blue-300')}
        >
          {client.vendor}
        </button>
      ) : (
        <span className="text-gray-600">n/a</span>
      )}
    </span>
  );
}

// ---- ColumnSettingsPanel ----
// Rendered inline inside the toolbar div -- no absolute positioning.
// The gear button toggles showSettings in the parent; this panel mounts/unmounts
// in the DOM flow, pushing the header and table down when open.
function ColumnSettingsPanel({ columns, onChange, onClose }) {
  const dragIdx = useRef(null);
  const [localCols, setLocalCols] = useState(columns);

  useEffect(function() { onChange(localCols); }, [localCols]);

  function toggleVisible(id) {
    setLocalCols(function(prev) {
      return prev.map(function(c) {
        return c.id === id ? Object.assign({}, c, { visible: !c.visible }) : c;
      });
    });
  }

  function toggleMobileVisible(id) {
    setLocalCols(function(prev) {
      return prev.map(function(c) {
        return c.id === id ? Object.assign({}, c, { mobileVisible: !c.mobileVisible }) : c;
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
      const next  = prev.slice();
      const moved = next.splice(dragIdx.current, 1)[0];
      next.splice(idx, 0, moved);
      dragIdx.current = idx;
      return next;
    });
  }

  function onDragEnd() { dragIdx.current = null; }

  function resetToDefault() {
    setLocalCols(DEFAULT_COLUMNS.map(function(c) {
      return { id: c.id, label: c.label, defaultWidth: c.defaultWidth, visible: true, mobileVisible: c.mobileVisible };
    }));
  }

  return (
    <div className="w-full bg-gray-800/50 border-t border-gray-700/60 p-3 select-none">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Columns</span>
        <div className="flex gap-2 items-center">
          <button onClick={resetToDefault} className="text-xs text-gray-500 hover:text-gray-300 transition-colors" title="Reset to default">Reset</button>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200 transition-colors text-base leading-none">&times;</button>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        {localCols.map(function(col, idx) {
          return (
            <div
              key={col.id}
              draggable
              onDragStart={function(e) { onDragStart(e, idx); }}
              onDragOver={function(e) { onDragOver(e, idx); }}
              onDragEnd={onDragEnd}
              className="flex items-center gap-2 py-1 px-1 rounded hover:bg-gray-700/40 cursor-grab active:cursor-grabbing"
            >
              <span className="text-gray-600 text-xs select-none">&#8597;</span>
              <span className="flex-1 text-xs text-gray-300">{col.label}</span>
              <label className="flex items-center gap-1 cursor-pointer" title="Show on desktop">
                <input
                  type="checkbox"
                  checked={col.visible}
                  onChange={function() { toggleVisible(col.id); }}
                  className="accent-blue-500 w-3 h-3"
                />
                <span className="text-xs text-gray-500 hidden sm:inline">Desktop</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer" title="Show on mobile">
                <input
                  type="checkbox"
                  checked={col.mobileVisible}
                  onChange={function() { toggleMobileVisible(col.id); }}
                  className="accent-purple-500 w-3 h-3"
                />
                <span className="text-xs text-gray-500 hidden sm:inline">Mobile</span>
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- ResizeHandle ----
function ResizeHandle({ colId, onResize, onDone }) {
  const startX   = useRef(null);
  const startW   = useRef(null);
  const dragging = useRef(false);

  function onMouseDown(e) {
    e.preventDefault();
    e.stopPropagation();
    startX.current   = e.clientX;
    dragging.current = true;

    function onMouseMove(ev) {
      if (!dragging.current) return;
      const delta = ev.clientX - startX.current;
      startX.current = ev.clientX;
      onResize(delta);
    }

    function onMouseUp() {
      dragging.current = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      if (onDone) onDone();
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  return (
    <span
      onMouseDown={onMouseDown}
      className="absolute right-0 top-0 h-full w-2 cursor-col-resize select-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
      style={{ touchAction: 'none' }}
    >
      <span className="w-px h-4 bg-gray-600 rounded" />
    </span>
  );
}

const SORTABLE = new Set(['mac', 'vendor', 'hostname', 'ip', 'apName', 'iface', 'rssi', 'tx_bytes', 'rx_bytes', 'first_seen']);

// ---- ClientTable ----
export default function ClientTable({ clients, disconnecting, onDisconnect }) {
  const [search, setSearch]               = useState('');
  const [sortCols, setSortCols]           = useState(function() { return loadSortPrefs() || DEFAULT_SORT; });
  const [activeAps, setActiveAps]         = useState(new Set());
  const [activeVendors, setActiveVendors] = useState(new Set());
  const [activeOuis, setActiveOuis]       = useState(new Set());
  const [meshOnly, setMeshOnly]           = useState(false);
  const [showSettings, setShowSettings]   = useState(false);

  // Use matchMedia for breakpoint detection. This is driven by the CSS engine
  // and never fires spuriously due to mobile viewport reflows (address bar,
  // keyboard, etc.) the way a window resize listener does.
  const [isMobile, setIsMobile] = useState(function() {
    var mq = getMq();
    return mq ? mq.matches : false;
  });
  useEffect(function() {
    var mq = getMq();
    if (!mq) return;
    function onChange(e) { setIsMobile(e.matches); }
    mq.addEventListener('change', onChange);
    return function() { mq.removeEventListener('change', onChange); };
  }, []);

  const [columns, setColumns] = useState(function() {
    const saved = loadColumnPrefs();
    if (saved) return saved;
    return DEFAULT_COLUMNS.map(function(c) {
      return { id: c.id, label: c.label, defaultWidth: c.defaultWidth, visible: true, mobileVisible: c.mobileVisible };
    });
  });

  const [colWidths, setColWidths] = useState(loadWidthPrefs);

  function getWidth(col) { return colWidths[col.id] || col.defaultWidth; }

  function handleResize(colId, delta) {
    setColWidths(function(prev) {
      const def = DEFAULT_COLUMNS.find(function(c) { return c.id === colId; });
      const cur = prev[colId] || (def ? def.defaultWidth : 100);
      return Object.assign({}, prev, { [colId]: Math.max(MIN_COL_WIDTH, cur + delta) });
    });
  }

  function handleResizeDone() {
    setColWidths(function(w) { saveWidthPrefs(w); return w; });
  }

  useEffect(function() { saveColumnPrefs(columns); }, [columns]);

  useEffect(function() { saveSortPrefs(sortCols); }, [sortCols]);

  // Outside-click-to-close removed: the settings panel is now an inline
  // accordion that pushes content down, so no floating overlay to dismiss.

  // Refresh relative timestamps every 30 s.
  const [, setTick] = useState(0);
  useEffect(function() {
    const id = setInterval(function() { setTick(function(n) { return n + 1; }); }, 30000);
    return function() { clearInterval(id); };
  }, []);

  // Which columns to show depends on the current breakpoint.
  const visibleCols = columns.filter(function(c) {
    return isMobile ? c.mobileVisible : c.visible;
  });

  // Desktop: sum of fixed px column widths. Mobile: auto layout.
  const tableWidth = isMobile
    ? 'auto'
    : visibleCols.reduce(function(sum, c) { return sum + getWidth(c); }, 0) + 'px';

  function toggleFacet(setter, value) {
    setter(function(prev) {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  }

  function toggleSort(key, e) {
    setSortCols(function(prev) {
      // Shift held = single-column (replace) mode. Default = multi-column.
      const single = e && e.shiftKey;
      const existing = prev.find(function(s) { return s.key === key; });
      if (single) {
        if (existing && prev.length === 1) {
          if (existing.dir === 'asc') return [{ key: key, dir: 'desc' }];
          return DEFAULT_SORT;
        }
        return [{ key: key, dir: 'asc' }];
      }
      // Multi-column mode (default)
      if (existing) {
        if (existing.dir === 'asc') return prev.map(function(s) { return s.key === key ? { key: key, dir: 'desc' } : s; });
        const next = prev.filter(function(s) { return s.key !== key; });
        return next.length > 0 ? next : DEFAULT_SORT;
      }
      return prev.concat([{ key: key, dir: 'asc' }]);
    });
  }

  function resetSort() { setSortCols(DEFAULT_SORT); }

  const isDefaultSort = sortCols.length === 1 && sortCols[0].key === 'ip' && sortCols[0].dir === 'asc';

  function sortMark(key) {
    const s = sortCols.find(function(c) { return c.key === key; });
    if (!s) return null;
    const idx = sortCols.indexOf(s);
    return (
      <span className="ml-1 text-blue-400 text-xs">
        {s.dir === 'asc' ? '\u2191' : '\u2193'}
        {sortCols.length > 1 ? <sup className="text-blue-500/70">{idx + 1}</sup> : null}
      </span>
    );
  }

  function clearAll() {
    setSearch('');
    setActiveAps(new Set());
    setActiveVendors(new Set());
    setActiveOuis(new Set());
    setMeshOnly(false);
    resetSort();
  }

  // ---- Filtering ----
  const searchLower = search.toLowerCase();
  const filtered = clients.filter(function(c) {
    if (meshOnly && !c.isMeshNode) return false;
    if (activeAps.size > 0 && !activeAps.has(c.apName)) return false;
    if (activeVendors.size > 0 && !activeVendors.has(c.vendor)) return false;
    if (activeOuis.size > 0) {
      const oui = macOui(c.mac);
      if (!oui || !activeOuis.has(oui)) return false;
    }
    if (!searchLower) return true;
    return (
      (c.mac      && c.mac.toLowerCase().includes(searchLower)) ||
      (c.hostname && c.hostname.toLowerCase().includes(searchLower)) ||
      (c.ip       && c.ip.toLowerCase().includes(searchLower)) ||
      (c.vendor   && c.vendor.toLowerCase().includes(searchLower)) ||
      (c.apName   && c.apName.toLowerCase().includes(searchLower))
    );
  });

  // ---- Sorting ----
  const sorted = filtered.slice().sort(function(a, b) {
    for (var i = 0; i < sortCols.length; i++) {
      const sc  = sortCols[i];
      const cmp = compareByKey(a, b, sc.key);
      if (cmp !== 0) return sc.dir === 'asc' ? cmp : -cmp;
    }
    return 0;
  });

  // ---- AP list for filter chips ----
  const allAps = Array.from(new Set(clients.map(function(c) { return c.apName; }).filter(Boolean))).sort();

  const hasFilters = search || activeAps.size > 0 || activeVendors.size > 0 || activeOuis.size > 0 || meshOnly || !isDefaultSort;

  return (
    <div className="w-full flex flex-col gap-2 max-w-full">

      {/* ---- Toolbar ---- */}
      <div className="flex-none flex flex-col gap-2">

        {/* Search + gear */}
        <div className="flex items-center gap-2">
          <input
            type="search"
            placeholder="Search MAC, hostname, IP, vendor, AP..."
            value={search}
            onChange={function(e) { setSearch(e.target.value); }}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
          />
          <button
            onClick={function() { setShowSettings(function(v) { return !v; }); }}
            title="Column settings"
            className={
              'p-1.5 rounded-lg border transition-colors ' +
              (showSettings
                ? 'bg-blue-900/40 border-blue-600/60 text-blue-300'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600')
            }
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
            </svg>
          </button>
          {hasFilters && (
            <button
              onClick={clearAll}
              title="Clear all filters and sort"
              className="p-1.5 rounded-lg border border-gray-700 bg-gray-800 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          )}
        </div>

        {/* Column settings panel */}
        {showSettings && (
          <ColumnSettingsPanel
            columns={columns}
            onChange={setColumns}
            onClose={function() { setShowSettings(false); }}
          />
        )}

        {/* AP filter chips */}
        {allAps.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {allAps.map(function(ap) {
              const active = activeAps.has(ap);
              return (
                <button
                  key={ap}
                  onClick={function() { toggleFacet(setActiveAps, ap); }}
                  className={
                    'px-2 py-0.5 rounded-full text-xs font-medium border transition-colors ' +
                    (active
                      ? 'bg-blue-800/60 border-blue-500/70 text-blue-200'
                      : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-blue-600/50 hover:text-blue-300')
                  }
                >
                  {ap}
                </button>
              );
            })}
          </div>
        )}

        {/* Active filter summary */}
        {(activeVendors.size > 0 || activeOuis.size > 0 || meshOnly) && (
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-xs text-gray-500">Filtering by:</span>
            {meshOnly && (
              <button
                onClick={function() { setMeshOnly(false); }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-indigo-800/60 border-indigo-500/70 text-indigo-200 hover:bg-indigo-700/60 transition-colors"
              >
                Mesh Node <span className="ml-0.5 opacity-70">&times;</span>
              </button>
            )}
            {Array.from(activeVendors).map(function(v) {
              return (
                <button
                  key={v}
                  onClick={function() { toggleFacet(setActiveVendors, v); }}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-blue-800/60 border-blue-500/70 text-blue-200 hover:bg-blue-700/60 transition-colors"
                >
                  {v} <span className="ml-0.5 opacity-70">&times;</span>
                </button>
              );
            })}
            {Array.from(activeOuis).map(function(oui) {
              return (
                <button
                  key={oui}
                  onClick={function() { toggleFacet(setActiveOuis, oui); }}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-blue-800/60 border-blue-500/70 text-blue-200 hover:bg-blue-700/60 transition-colors font-mono"
                >
                  {oui} <span className="ml-0.5 opacity-70 font-sans">&times;</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ---- Table ---- */}
      {/* Desktop: overflow-x-auto + fixed column widths.
          Mobile: full-width auto layout, no horizontal scroll. */}
      <div className="flex-1 sm:overflow-auto rounded-lg border border-gray-800">
        <table
          className="text-sm border-collapse"
          style={{ width: tableWidth, minWidth: isMobile ? '100%' : undefined }}
        >
          <thead className="sticky top-0 z-10 bg-gray-900">
            <tr>
              {visibleCols.map(function(col) {
                const sortable = SORTABLE.has(col.id);
                const isActive  = sortable && sortCols.some(function(s) { return s.key === col.id; });
                return (
                  <th
                    key={col.id}
                    style={isMobile ? undefined : { width: getWidth(col) + 'px', minWidth: getWidth(col) + 'px', maxWidth: getWidth(col) + 'px' }}
                    className={
                      'relative group text-left px-3 py-2 text-xs font-semibold uppercase tracking-wider border-b border-gray-800 select-none whitespace-nowrap ' +
                      (sortable ? 'cursor-pointer ' : '') +
                      (isActive ? 'text-blue-400 bg-blue-950/30 ' : 'text-gray-400 ') +
                      (isActive ? 'text-gray-300' : sortable ? 'hover:text-gray-300' : '')
                    }
                    onClick={sortable ? function(e) { toggleSort(col.id, e); } : undefined}
                    title={sortable ? 'Click to sort (multi-column). Shift+click to sort by this column only.' : undefined}
                  >
                    <span className="truncate">{col.label}{sortable ? sortMark(col.id) : null}</span>
                    {!isMobile && (
                      <ResizeHandle
                        colId={col.id}
                        onResize={function(delta) { handleResize(col.id, delta); }}
                        onDone={handleResizeDone}
                      />
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={visibleCols.length} className="px-3 py-8 text-center text-gray-500 text-sm">
                  {clients.length === 0 ? 'No clients connected.' : 'No clients match the current filters.'}
                </td>
              </tr>
            )}
            {sorted.map(function(client) {
              return (
                <tr
                  key={client.mac}
                  className="border-b border-gray-800/60 hover:bg-gray-800/40 transition-colors"
                >
                  {visibleCols.map(function(col) {
                    if (col.id === 'mac') {
                      return (
                        <td key="mac" className="px-3 py-2 font-mono text-xs text-gray-300 whitespace-nowrap overflow-hidden text-ellipsis" style={isMobile ? undefined : { maxWidth: getWidth(col) + 'px' }}>
                          {client.mac}
                        </td>
                      );
                    }
                    if (col.id === 'vendor') {
                      return (
                        <td key="vendor" className="px-3 py-2 whitespace-nowrap overflow-hidden text-ellipsis" style={isMobile ? undefined : { maxWidth: getWidth(col) + 'px' }}>
                          <VendorCell
                            client={client}
                            isMeshActive={meshOnly}
                            activeVendors={activeVendors}
                            activeOuis={activeOuis}
                            onMeshClick={function() { setMeshOnly(function(v) { return !v; }); }}
                            onVendorClick={function(v) { toggleFacet(setActiveVendors, v); }}
                            onOuiClick={function(oui) { toggleFacet(setActiveOuis, oui); }}
                          />
                        </td>
                      );
                    }
                    if (col.id === 'hostname') {
                      return (
                        <td key="hostname" className="px-3 py-2 text-gray-200 whitespace-nowrap overflow-hidden text-ellipsis" style={isMobile ? undefined : { maxWidth: getWidth(col) + 'px' }}>
                          {client.hostname || <span className="text-gray-600">n/a</span>}
                        </td>
                      );
                    }
                    if (col.id === 'ip') {
                      return (
                        <td key="ip" className="px-3 py-2 font-mono text-xs text-gray-300 whitespace-nowrap" style={isMobile ? undefined : { maxWidth: getWidth(col) + 'px' }}>
                          {client.ip || <span className="text-gray-600">n/a</span>}
                        </td>
                      );
                    }
                    if (col.id === 'apName') {
                      return (
                        <td key="apName" className="px-3 py-2 text-gray-400 text-xs whitespace-nowrap overflow-hidden text-ellipsis" style={isMobile ? undefined : { maxWidth: getWidth(col) + 'px' }}>
                          {client.apName || <span className="text-gray-600">n/a</span>}
                        </td>
                      );
                    }
                    if (col.id === 'iface') {
                      return (
                        <td key="iface" className="px-3 py-2 text-gray-400 text-xs whitespace-nowrap" style={isMobile ? undefined : { maxWidth: getWidth(col) + 'px' }}>
                          {client.iface || <span className="text-gray-600">n/a</span>}
                        </td>
                      );
                    }
                    if (col.id === 'rssi') {
                      return (
                        <td key="rssi" className={'px-3 py-2 font-mono text-xs whitespace-nowrap ' + rssiColor(client.rssi)} style={isMobile ? undefined : { maxWidth: getWidth(col) + 'px' }}>
                          {client.rssi != null ? client.rssi + ' dBm' : <span className="text-gray-600">n/a</span>}
                        </td>
                      );
                    }
                    if (col.id === 'tx_bytes') {
                      const fmt = fmtBytes(client.tx_bytes);
                      return (
                        <td key="tx_bytes" className="px-3 py-2 font-mono text-xs text-gray-400 whitespace-nowrap" style={isMobile ? undefined : { maxWidth: getWidth(col) + 'px' }}>
                          {fmt != null ? fmt : <span className="text-gray-600">n/a</span>}
                        </td>
                      );
                    }
                    if (col.id === 'rx_bytes') {
                      const fmt = fmtBytes(client.rx_bytes);
                      return (
                        <td key="rx_bytes" className="px-3 py-2 font-mono text-xs text-gray-400 whitespace-nowrap" style={isMobile ? undefined : { maxWidth: getWidth(col) + 'px' }}>
                          {fmt != null ? fmt : <span className="text-gray-600">n/a</span>}
                        </td>
                      );
                    }
                    if (col.id === 'first_seen') {
                      const rel = fmtRelative(client.first_seen);
                      const abs = fmtAbsolute(client.first_seen);
                      return (
                        <td key="first_seen" className="px-3 py-2 text-xs text-gray-400 whitespace-nowrap" title={abs} style={isMobile ? undefined : { maxWidth: getWidth(col) + 'px' }}>
                          {rel || <span className="text-gray-600">n/a</span>}
                        </td>
                      );
                    }
                    if (col.id === 'actions') {
                      return (
                        <td key="actions" className="px-3 py-2 whitespace-nowrap" style={isMobile ? undefined : { maxWidth: getWidth(col) + 'px' }}>
                          <button
                            onClick={function() { onDisconnect(client.mac); }}
                            disabled={!!disconnecting[client.mac]}
                            className="px-2 py-1 text-xs rounded border border-red-800/60 text-red-400 hover:bg-red-900/30 hover:border-red-600/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {disconnecting[client.mac] ? 'Disconnecting...' : 'Disconnect'}
                          </button>
                        </td>
                      );
                    }
                    return null;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ---- Footer ---- */}
      <div className="flex-none text-xs text-gray-600 pb-1">
        {filtered.length !== clients.length
          ? filtered.length + ' of ' + clients.length + ' clients'
          : clients.length + ' client' + (clients.length !== 1 ? 's' : '')}
        {!isDefaultSort && (
          <button onClick={resetSort} className="ml-3 text-blue-600 hover:text-blue-400 transition-colors">Reset sort</button>
        )}
      </div>
    </div>
  );
}
