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
    // right-0 aligns panel right edge with the gear button right edge.
    // max-w-[calc(100vw-1rem)] prevents it from overflowing the left edge of
    // the viewport on narrow mobile screens where w-80 (320px) would be too wide.
    <div className="absolute right-0 top-8 z-50 w-80 max-w-[calc(100vw-1rem)] bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-3 select-none">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">Columns</span>
        <div className="flex gap-2 items-center">
          <button onClick={resetToDefault} className="text-xs text-gray-500 hover:text-gray-300 transition-colors" title="Reset to default">Reset</button>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200 transition-colors text-base leading-none" title="Close">&times;</button>
        </div>
      </div>
      <div className="flex items-center gap-2 mb-2 px-2">
        <span className="text-xs text-gray-600 flex-1 pl-6">Column</span>
        <span className="text-xs text-gray-500 w-12 text-center" title="Visible on desktop">Desktop</span>
        <span className="text-xs text-gray-500 w-12 text-center" title="Visible on mobile">Mobile</span>
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
              <span className={'text-xs flex-1 ' + (col.visible || col.mobileVisible ? 'text-gray-200' : 'text-gray-500')}>
                {col.label}
              </span>
              <button
                onClick={function() { toggleVisible(col.id); }}
                className={
                  'w-5 h-5 rounded border flex-shrink-0 flex items-center justify-center transition-colors ' +
                  (col.visible ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-700 border-gray-600 text-transparent')
                }
                title={col.visible ? 'Hide on desktop' : 'Show on desktop'}
              >
                <svg viewBox="0 0 10 8" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 4l3 3 5-6"/>
                </svg>
              </button>
              <button
                onClick={function() { toggleMobileVisible(col.id); }}
                className={
                  'w-5 h-5 rounded border flex-shrink-0 flex items-center justify-center transition-colors ' +
                  (col.mobileVisible ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-gray-700 border-gray-600 text-transparent')
                }
                title={col.mobileVisible ? 'Hide on mobile' : 'Show on mobile'}
              >
                <svg viewBox="0 0 10 8" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 4l3 3 5-6"/>
                </svg>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-4 mt-2 px-2">
        <span className="flex items-center gap-1 text-xs text-gray-600">
          <span className="inline-block w-3 h-3 rounded bg-blue-600 border border-blue-500"></span> Desktop
        </span>
        <span className="flex items-center gap-1 text-xs text-gray-600">
          <span className="inline-block w-3 h-3 rounded bg-emerald-600 border border-emerald-500"></span> Mobile
        </span>
        <span className="text-xs text-gray-600 flex-1 text-right">Drag to reorder</span>
      </div>
    </div>
  );
}

// ---- ResizeHandle ----
// Only rendered on desktop; not shown on mobile.
function ResizeHandle({ onResize, onDone }) {
  const startX = useRef(null);

  function onMouseDown(e) {
    e.preventDefault();
    e.stopPropagation();
    startX.current = e.clientX;
    function onMove(ev) {
      onResize(ev.clientX - startX.current);
      startX.current = ev.clientX;
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      onDone();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  return (
    <span
      onMouseDown={onMouseDown}
      className="absolute right-0 top-0 h-full w-2 cursor-col-resize flex items-center justify-center group/rh select-none z-10"
      title="Drag to resize"
    >
      <span className="w-px h-4 bg-gray-700 group-hover/rh:bg-blue-500 transition-colors rounded-full"></span>
    </span>
  );
}

// ---- Sortable column ids (actions excluded) ----
const SORTABLE = new Set(['mac', 'vendor', 'hostname', 'ip', 'apName', 'iface', 'rssi', 'tx_bytes', 'rx_bytes', 'first_seen']);

// ---- ClientTable ----
export default function ClientTable({ clients, disconnecting, onDisconnect }) {
  const [search, setSearch]               = useState('');
  const [sortCols, setSortCols]           = useState(DEFAULT_SORT);
  const [activeAps, setActiveAps]         = useState(new Set());
  const [activeVendors, setActiveVendors] = useState(new Set());
  const [activeOuis, setActiveOuis]       = useState(new Set());
  const [meshOnly, setMeshOnly]           = useState(false);
  const [showSettings, setShowSettings]   = useState(false);
  const settingsRef = useRef(null);

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

  const tableWidth = columns
    .filter(function(c) { return c.visible; })
    .reduce(function(sum, c) { return sum + getWidth(c); }, 0);

  useEffect(function() {
    saveColumnPrefs(columns);
  }, [columns]);

  // Close settings panel on outside click
  useEffect(function() {
    function handler(e) {
      if (settingsRef.current && !settingsRef.current.contains(e.target)) {
        setShowSettings(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return function() { document.removeEventListener('mousedown', handler); };
  }, []);

  function handleResize(colId, delta) {
    setColWidths(function(prev) {
      const col = columns.find(function(c) { return c.id === colId; });
      const cur = prev[colId] || (col ? col.defaultWidth : 100);
      return Object.assign({}, prev, { [colId]: Math.max(MIN_COL_WIDTH, cur + delta) });
    });
  }

  function handleResizeDone() {
    saveWidthPrefs(colWidths);
  }

  function toggleSort(key, e) {
    const shift = e && e.shiftKey;
    setSortCols(function(prev) {
      const existing = prev.find(function(s) { return s.key === key; });
      if (!shift) {
        if (existing) {
          return existing.dir === 'asc'
            ? [{ key, dir: 'desc' }]
            : [{ key, dir: 'asc' }];
        }
        return [{ key, dir: 'asc' }];
      }
      // Multi-sort
      if (existing) {
        const next = prev.filter(function(s) { return s.key !== key; });
        if (existing.dir === 'asc') next.push({ key, dir: 'desc' });
        return next.length ? next : DEFAULT_SORT;
      }
      return prev.concat({ key, dir: 'asc' });
    });
  }

  function resetSort() { setSortCols(DEFAULT_SORT); }

  const isDefaultSort =
    sortCols.length === 1 &&
    sortCols[0].key === DEFAULT_SORT[0].key &&
    sortCols[0].dir === DEFAULT_SORT[0].dir;

  function sortMark(key) {
    const s = sortCols.find(function(sc) { return sc.key === key; });
    if (!s) return null;
    const idx = sortCols.indexOf(s);
    const arrow = s.dir === 'asc' ? ' \u2191' : ' \u2193';
    return (
      <span className="text-blue-400 ml-0.5">
        {arrow}{sortCols.length > 1 ? <sup className="text-blue-500">{idx + 1}</sup> : null}
      </span>
    );
  }

  const visibleCols = isMobile
    ? columns.filter(function(c) { return c.mobileVisible; })
    : columns.filter(function(c) { return c.visible; });

  // ---- Filtering ----
  function toggleSet(setter, val) {
    setter(function(prev) {
      const next = new Set(prev);
      if (next.has(val)) next.delete(val); else next.add(val);
      return next;
    });
  }

  function toggleAp(ap)         { toggleSet(setActiveAps, ap); }
  function toggleVendor(vendor) { toggleSet(setActiveVendors, vendor); }
  function toggleOui(oui)       { toggleSet(setActiveOuis, oui); }
  function toggleMesh()         { setMeshOnly(function(v) { return !v; }); }

  const filtered = clients.filter(function(c) {
    if (meshOnly && !c.isMeshNode) return false;
    if (activeAps.size    > 0 && !activeAps.has(c.apName))         return false;
    if (activeVendors.size > 0 && !activeVendors.has(c.vendor))    return false;
    if (activeOuis.size   > 0 && !activeOuis.has(macOui(c.mac)))   return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (c.mac      && c.mac.toLowerCase().includes(q))      ||
      (c.vendor   && c.vendor.toLowerCase().includes(q))   ||
      (c.hostname && c.hostname.toLowerCase().includes(q)) ||
      (c.ip       && c.ip.toLowerCase().includes(q))       ||
      (c.apName   && c.apName.toLowerCase().includes(q))
    );
  });

  const sorted = filtered.slice().sort(function(a, b) {
    for (var i = 0; i < sortCols.length; i++) {
      const s   = sortCols[i];
      const cmp = compareByKey(a, b, s.key);
      if (cmp !== 0) return s.dir === 'asc' ? cmp : -cmp;
    }
    return 0;
  });

  // ---- Filter chips ----
  const hasFilter = activeAps.size > 0 || activeVendors.size > 0 || activeOuis.size > 0 || meshOnly || search;

  function clearAll() {
    setActiveAps(new Set());
    setActiveVendors(new Set());
    setActiveOuis(new Set());
    setMeshOnly(false);
    setSearch('');
  }

  const chips = [];
  if (meshOnly) chips.push({ label: 'Mesh Nodes', remove: toggleMesh });
  activeAps.forEach(function(ap) {
    chips.push({ label: 'AP: ' + ap, remove: function() { toggleAp(ap); } });
  });
  activeVendors.forEach(function(v) {
    chips.push({ label: 'Vendor: ' + v, remove: function() { toggleVendor(v); } });
  });
  activeOuis.forEach(function(o) {
    chips.push({ label: 'OUI: ' + o, remove: function() { toggleOui(o); } });
  });

  // ---- Cell renderer ----
  function renderCell(c, col) {
    const isDiscovered = c.connectionType === 'discovered';
    const style = isMobile ? {} : { width: getWidth(col) + 'px', maxWidth: getWidth(col) + 'px', overflow: 'hidden' };
    switch (col.id) {
      case 'mac':
        return (
          <td key="mac" style={style} className="px-3 py-3 font-mono text-xs text-gray-300 whitespace-nowrap">
            {c.mac || <span className="text-gray-600">n/a</span>}
          </td>
        );

      case 'vendor':
        return (
          <td key="vendor" style={style} className="px-3 py-3 text-xs">
            <VendorCell
              client={c}
              isMeshActive={meshOnly}
              activeVendors={activeVendors}
              activeOuis={activeOuis}
              onMeshClick={toggleMesh}
              onVendorClick={toggleVendor}
              onOuiClick={toggleOui}
            />
          </td>
        );

      case 'hostname':
        return (
          <td key="hostname" style={style} className="px-3 py-3 text-xs text-gray-300 truncate">
            {c.hostname || <span className="text-gray-600">n/a</span>}
          </td>
        );

      case 'ip':
        return (
          <td key="ip" style={style} className="px-3 py-3 font-mono text-xs text-gray-300 whitespace-nowrap">
            <span className="flex items-center gap-1.5">
              {c.ip || <span className="text-gray-600">n/a</span>}
              {isDiscovered && (
                <span
                  className="inline-block text-xs rounded px-1 py-0.5 border border-amber-700/50 bg-amber-900/20 text-amber-400"
                  title="Discovered via ARP -- not an active Wi-Fi client"
                >
                  ARP
                </span>
              )}
            </span>
          </td>
        );

      case 'apName':
        return (
          <td key="apName" style={style} className="px-3 py-3 text-xs truncate">
            {c.apName ? (
              <button
                onClick={function() { toggleAp(c.apName); }}
                title={'Filter by AP: ' + c.apName}
                className={'transition-colors ' + (activeAps.has(c.apName) ? 'text-blue-300' : 'text-gray-400 hover:text-blue-300')}
              >
                {c.apName}
              </button>
            ) : (
              <span className="text-gray-600">n/a</span>
            )}
          </td>
        );

      case 'iface':
        return (
          <td key="iface" style={style} className="px-3 py-3 font-mono text-xs text-gray-500 whitespace-nowrap">
            {c.iface || <span className="text-gray-600">n/a</span>}
          </td>
        );

      case 'rssi':
        return (
          <td key="rssi" style={style} className={'px-3 py-3 font-mono text-xs ' + rssiColor(c.rssi)}>
            {c.rssi != null ? c.rssi + ' dBm' : <span className="text-gray-600">n/a</span>}
          </td>
        );

      case 'tx_bytes':
        return (
          <td key="tx_bytes" style={style} className="px-3 py-3 font-mono text-xs text-gray-400">
            {fmtBytes(c.tx_bytes) !== null ? fmtBytes(c.tx_bytes) : <span className="text-gray-600">n/a</span>}
          </td>
        );

      case 'rx_bytes':
        return (
          <td key="rx_bytes" style={style} className="px-3 py-3 font-mono text-xs text-gray-400">
            {fmtBytes(c.rx_bytes) !== null ? fmtBytes(c.rx_bytes) : <span className="text-gray-600">n/a</span>}
          </td>
        );

      case 'first_seen':
        return (
          <td key="first_seen" style={style} className="px-3 py-3 text-xs text-gray-500" title={fmtAbsolute(c.first_seen)}>
            {fmtRelative(c.first_seen) || <span className="text-gray-600">n/a</span>}
          </td>
        );

      case 'actions':
        return (
          <td key="actions" style={style} className="px-3 py-3 text-right">
            {/* Only show disconnect for wifi clients -- not mesh nodes or discovered (ARP-only) hosts. */}
            {!c.isMeshNode && !isDiscovered && (
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
        return <td key={col.id} style={style} className="px-3 py-3 text-gray-600">-</td>;
    }
  }

  // Desktop: 97% width avoids pixel-math phantom scrollbars caused by sub-pixel
  //   rounding between the table and the card. maxWidth caps it so the card never
  //   exceeds the table's natural width. overflowX:auto on the card handles
  //   horizontal scrolling; the scroll div is vertical only (overflow-y-auto).
  // Mobile: overflowX:auto lets the card itself scroll horizontally when the
  //   auto-width table exceeds the outer shell. Without this the table bleeds
  //   over the shell rather than staying contained inside it.
  const cardStyle = isMobile
    ? { width: '100%', minWidth: 0, overflowX: 'auto' }
    : { width: '97%', maxWidth: (tableWidth + 2) + 'px', minWidth: '400px', overflowX: 'auto' };

  // Desktop: scroll div is the sole scroll container for both axes.
  //   Height is bounded by sm:h-full on the card inside the viewport-locked shell.
  // Mobile: no overflow on the scroll div -- page scrolls.
  const scrollDivStyle = isMobile
    ? {}
    : { scrollbarWidth: 'thin', scrollbarColor: '#374151 transparent' };

  return (
    // Desktop: sm:h-full fills the bounded flex-1 container from App.jsx.
    // Mobile: no height constraint, content flows naturally.
    <div style={cardStyle} className="flex flex-col bg-gray-900 rounded-xl border border-gray-800 sm:h-full">

      {/* Toolbar */}
      <div className="flex-none px-4 py-3 border-b border-gray-800 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-sm font-semibold text-gray-300">Connected Clients</h2>
            {isMobile && (
              <span className="text-xs text-emerald-400 border border-emerald-700/50 bg-emerald-900/20 rounded px-1.5 py-0.5">Mobile view</span>
            )}
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
            <input
              type="text"
              placeholder="Search..."
              value={search}
              onChange={function(e) { setSearch(e.target.value); }}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 w-40 sm:w-64"
            />
            {hasFilter && (
              <button
                onClick={clearAll}
                title="Clear all filters"
                className="text-gray-500 hover:text-gray-200 transition-colors text-base leading-none"
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

      {/* Desktop: vertical scroll only -- horizontal is handled by the card's
          overflowX:auto. Using overflow-y-auto avoids phantom horizontal scrollbars
          from sub-pixel rounding between the table width and scroll div clientWidth.
          Mobile: no overflow -- page scrolls. */}
      <div className={isMobile ? 'w-full' : 'flex-1 overflow-y-auto'} style={scrollDivStyle}>
        <table
          className="text-sm border-collapse"
          style={isMobile
            ? { tableLayout: 'auto', width: '100%' }
            : { tableLayout: 'fixed', width: tableWidth + 'px' }
          }
        >
          {!isMobile && (
            <colgroup>
              {visibleCols.map(function(col) {
                return <col key={col.id} style={{ width: getWidth(col) + 'px' }} />;
              })}
            </colgroup>
          )}
          <thead>
            <tr
              className="text-gray-500 text-xs uppercase tracking-wider border-b border-gray-800 bg-gray-900"
              style={{ position: 'sticky', top: 0, zIndex: 20 }}
            >
              {visibleCols.map(function(col) {
                const sortable  = SORTABLE.has(col.id);
                const isActive  = sortable && sortCols.some(function(s) { return s.key === col.id; });
                const isActions = col.id === 'actions';
                const thStyle   = isMobile
                  ? { position: 'relative' }
                  : (function() {
                      const w = getWidth(col);
                      return { width: w + 'px', minWidth: w + 'px', maxWidth: w + 'px', position: 'relative' };
                    })();
                return (
                  <th
                    key={col.id}
                    style={thStyle}
                    onClick={sortable ? function(e) { toggleSort(col.id, e); } : undefined}
                    className={
                      'px-3 py-2 select-none transition-colors whitespace-nowrap overflow-hidden ' +
                      (isActions ? 'text-right ' : 'text-left ') +
                      (sortable ? 'cursor-pointer ' : '') +
                      (isActive ? 'text-gray-300' : sortable ? 'hover:text-gray-300' : '')
                    }
                    title={sortable ? 'Click to sort. Shift+click for multi-sort.' : undefined}
                  >
                    <span className="truncate">{col.label}{sortable ? sortMark(col.id) : null}</span>
                    {!isMobile && (
                      <ResizeHandle
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
                <td colSpan={visibleCols.length} className="px-4 py-10 text-center text-gray-600">
                  {clients.length === 0 ? 'No clients connected.' : 'No results for your search.'}
                </td>
              </tr>
            )}
            {sorted.map(function(c) {
              const isMeshRow = c.isMeshNode;
              const isDisc    = c.connectionType === 'discovered';
              return (
                <tr
                  key={c.mac}
                  className={
                    'border-b border-gray-800 last:border-0 transition-colors ' +
                    (isMeshRow ? 'bg-indigo-950/20 hover:bg-indigo-950/30' :
                     isDisc    ? 'bg-amber-950/10 hover:bg-amber-950/20'   :
                                 'hover:bg-gray-800/50')
                  }
                >
                  {visibleCols.map(function(col) { return renderCell(c, col); })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div className="flex-none px-4 py-2 border-t border-gray-800 text-xs text-gray-600">
        Showing {sorted.length} of {clients.length} client{clients.length !== 1 ? 's' : ''}
      </div>
    </div>
  );
}
