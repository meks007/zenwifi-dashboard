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
  { id: 'reachable',  label: 'Reachable',    defaultWidth: 120, mobileVisible: false },
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

const LS_SORT_KEY = 'zenwifi_sort_v1';

function loadSortPrefs() {
  try {
    const raw = localStorage.getItem(LS_SORT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed;
  } catch (_e) { return null; }
}

function saveSortPrefs(sort) {
  try { localStorage.setItem(LS_SORT_KEY, JSON.stringify(sort)); } catch (_e) {}
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
  if (key === 'reachable') {
    const at = a.last_ping_at ? new Date(a.last_ping_at).getTime() : 0;
    const bt = b.last_ping_at ? new Date(b.last_ping_at).getTime() : 0;
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
function ResizeHandle({ onResize, onDone }) {
  const startX  = useRef(null);
  const startVal = useRef(null);
function onMouseDown(e) {
    e.preventDefault();
    startX.current = e.clientX;
    startVal.current = 0;
    function onMove(ev) {
      const delta = ev.clientX - startX.current;
      onResize(delta - startVal.current);
      startVal.current = delta;
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
    <div
      onMouseDown={onMouseDown}
      className="absolute right-0 top-0 h-full w-2 cursor-col-resize flex items-center justify-center group/rh select-none z-10"
    >
      <span className="w-px h-4 bg-gray-700 group-hover/rh:bg-blue-500 transition-colors rounded-full"></span>
    </div>
  );
}

const SORTABLE = new Set(['mac', 'vendor', 'hostname', 'ip', 'apName', 'iface', 'rssi', 'tx_bytes', 'rx_bytes', 'first_seen', 'reachable']);
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
      const single = e && e.shiftKey;
      const existing = prev.find(function(s) { return s.key === key; });
      if (single) {
        // Shift+click: replace entire sort with just this column
        if (existing) {
          if (existing.dir === 'asc') return [{ key: key, dir: 'desc' }];
          return DEFAULT_SORT;
        }
        return [{ key: key, dir: 'asc' }];
      }
      // Default: multi-column sort
      if (existing) {
        if (existing.dir === 'asc') return prev.map(function(s) { return s.key === key ? { key: key, dir: 'desc' } : s; });
        // Remove from multi-sort; if it was the only column, reset to default
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
  }
const q = search.trim().toLowerCase();
const filtered = clients.filter(function(c) {
    if (meshOnly && !c.isMeshNode) return false;
    if (q) {
      const hit =
        (c.mac      && c.mac.toLowerCase().includes(q))      ||
        (c.vendor   && c.vendor.toLowerCase().includes(q))   ||
        (c.hostname && c.hostname.toLowerCase().includes(q)) ||
        (c.ip       && c.ip.toLowerCase().includes(q))       ||
        (c.apName   && c.apName.toLowerCase().includes(q))   ||
        (c.iface    && c.iface.toLowerCase().includes(q));
      if (!hit) return false;
    }
    if (activeAps.size     > 0 && !activeAps.has(c.apName))       return false;
    if (activeVendors.size > 0 && !activeVendors.has(c.vendor))   return false;
    if (activeOuis.size    > 0 && !activeOuis.has(macOui(c.mac))) return false;
    return true;
  });

  const sorted = filtered.slice().sort(function(a, b) {
    for (var i = 0; i < sortCols.length; i++) {
      const sc  = sortCols[i];
      const cmp = compareByKey(a, b, sc.key);
if (cmp !== 0) return sc.dir === 'asc' ? cmp : -cmp;
    }
    return 0;
  });

  const hasFilter = q || activeAps.size > 0 || activeVendors.size > 0 || activeOuis.size > 0 || meshOnly;

  const chips = [];
  if (meshOnly) chips.push({ label: 'Mesh only', remove: function() { setMeshOnly(false); } });
  activeAps.forEach(function(v)     { chips.push({ label: 'AP: '     + v, remove: function() { toggleFacet(setActiveAps, v);     } }); });
  activeVendors.forEach(function(v) { chips.push({ label: 'Vendor: ' + v, remove: function() { toggleFacet(setActiveVendors, v); } }); });
  activeOuis.forEach(function(v)    { chips.push({ label: 'OUI: '    + v, remove: function() { toggleFacet(setActiveOuis, v);    } }); });

  function renderCell(c, col) {
    const isMesh       = c.isMeshNode;
    const isDiscovered = c.connectionType === 'discovered';
    const style        = isMobile ? {} : { width: getWidth(col) + 'px', minWidth: getWidth(col) + 'px', maxWidth: getWidth(col) + 'px' };

    switch (col.id) {
      case 'mac':
        return <td key="mac" style={style} className="px-3 py-3 font-mono text-xs text-blue-300 overflow-hidden text-ellipsis whitespace-nowrap">{c.mac}</td>;

      case 'vendor':
        return (
          <td key="vendor" style={style} className="px-3 py-3 text-xs text-left overflow-hidden">
            <VendorCell
              client={c}
              isMeshActive={meshOnly}
              activeVendors={activeVendors}
              activeOuis={activeOuis}
              onMeshClick={function() { setMeshOnly(function(v) { return !v; }); }}
              onVendorClick={function(v) { toggleFacet(setActiveVendors, v); }}
              onOuiClick={function(v) { toggleFacet(setActiveOuis, v); }}
            />
          </td>
        );
case 'hostname':
        return (
          <td key="hostname" style={style} className="px-3 py-3 text-gray-300 overflow-hidden text-ellipsis whitespace-nowrap">
            {c.hostname || <span className="text-gray-600">n/a</span>}
          </td>
        );

      case 'ip':
        return (
          <td key="ip" style={style} className="px-3 py-3 font-mono text-xs text-gray-400 overflow-hidden text-ellipsis whitespace-nowrap">
            {c.ip || <span className="text-gray-600">n/a</span>}
          </td>
        );

      case 'apName': {
        const apActive = activeAps.has(c.apName);
        const apDot    = isMesh ? 'bg-indigo-400' : isDiscovered ? 'bg-amber-400' : 'bg-green-400';
        const apPill   = apActive
          ? 'bg-blue-900/50 border-blue-600/60 text-blue-300'
          : 'bg-gray-800/80 border-gray-700 text-gray-300 hover:bg-gray-700/70 hover:border-gray-500';
        return (
          <td key="apName" style={style} className="px-3 py-3 text-xs overflow-hidden">
            {c.apName ? (
              <button
                onClick={function(e) { e.stopPropagation(); toggleFacet(setActiveAps, c.apName); }}
                title={'Filter by AP: ' + c.apName}
                className={'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 border transition-colors ' + apPill}
              >
                <span className={'w-1.5 h-1.5 rounded-full flex-shrink-0 ' + apDot}></span>
                <span className="truncate max-w-[7rem]">{c.apName}</span>
              </button>
            ) : (
              <span className="text-gray-600">n/a</span>
            )}
          </td>
        );
      }

      case 'iface':
        return (
          <td key="iface" style={style} className="px-3 py-3 font-mono text-xs text-gray-500 overflow-hidden text-ellipsis whitespace-nowrap">
            {c.iface || 'n/a'}
          </td>
        );

      case 'rssi':
        return (
          <td key="rssi" style={style} className={'px-3 py-3 font-mono text-xs ' + rssiColor(c.rssi)}>
            {c.rssi != null ? c.rssi : <span className="text-gray-600">n/a</span>}
          </td>
        );

      case 'tx_bytes':
        return (
          <td key="tx_bytes" style={style} className="px-3 py-3 font-mono text-xs text-gray-400 overflow-hidden text-ellipsis whitespace-nowrap">
            {fmtBytes(c.tx_bytes) !== null ? fmtBytes(c.tx_bytes) : <span className="text-gray-600">n/a</span>}
          </td>
        );

      case 'rx_bytes':
        return (
          <td key="rx_bytes" style={style} className="px-3 py-3 font-mono text-xs text-gray-400 overflow-hidden text-ellipsis whitespace-nowrap">
            {fmtBytes(c.rx_bytes) !== null ? fmtBytes(c.rx_bytes) : <span className="text-gray-600">n/a</span>}
          </td>
        );

      case 'first_seen':
        return (
          <td key="first_seen" style={style} className="px-3 py-3 text-xs text-gray-500 overflow-hidden text-ellipsis whitespace-nowrap" title={fmtAbsolute(c.first_seen)}>
            {fmtRelative(c.first_seen) || <span className="text-gray-600">n/a</span>}
          </td>
        );

      case 'reachable': {
        // Only meaningful for discovered (wired) clients that have been pinged.
        if (!isDiscovered) {
          return <td key="reachable" style={style} className="px-3 py-3 text-gray-700 text-xs">-</td>;
        }
        var pingRel    = fmtRelative(c.last_ping_at);
        var pingResult = c.last_ping_result || null;
        // Derive success from "X/Y" string -- success means X === Y and X > 0
        var pingOk = false;
        if (pingResult) {
          var pingParts = pingResult.split('/');
          pingOk = pingParts.length === 2 && pingParts[0] === pingParts[1] && parseInt(pingParts[0], 10) > 0;
        }
        return (
          <td
            key="reachable"
            style={style}
            className="px-3 py-3 text-xs overflow-hidden text-ellipsis whitespace-nowrap"
            title={c.last_ping_at ? fmtAbsolute(c.last_ping_at) + ' - ' + (pingResult || '?') : 'Not yet pinged'}
          >
            {pingRel ? (
              <span className="inline-flex items-center gap-1.5">
                <span className={'w-1.5 h-1.5 rounded-full flex-shrink-0 ' + (pingOk ? 'bg-green-400' : 'bg-red-400')}></span>
                <span className="text-gray-400">{pingRel}</span>
                {pingResult && <span className={'font-mono ' + (pingOk ? 'text-green-400' : 'text-red-400')}>{pingResult}</span>}
              </span>
            ) : (
              <span className="text-gray-600">pending</span>
            )}
          </td>
        );
      }

      case 'actions':
        return (
          <td key="actions" style={style} className="px-3 py-3 text-right overflow-hidden">
            {!c.isMeshNode && !isDiscovered && (
              <button
                onClick={function(e) { e.stopPropagation(); onDisconnect(c.mac); }}
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

  // Desktop: card is 102% wide so the table (100% of card) always has room and
  //   never causes a phantom horizontal scrollbar from sub-pixel rounding.
  //   overflowX:auto on the card handles real horizontal scrolling when columns
  //   exceed the viewport. The scroll div only scrolls vertically (overflow-y-auto),
  //   which keeps position:sticky on thead working correctly.
  // Mobile: card is 100% wide with overflowX:auto so the auto-layout table is
  //   contained inside the card and scrolls horizontally within it.
  const cardStyle = isMobile
    ? { width: '100%', minWidth: 0, overflowX: 'auto' }
    : { width: '102%', minWidth: '400px', overflowX: 'auto' };

  // Desktop: thin themed scrollbar on the vertical scroll div.
  // Mobile: no style needed.
  const scrollDivStyle = isMobile
    ? {}
    : { scrollbarWidth: 'thin', scrollbarColor: '#374151 transparent' };

  return (
    // Desktop: sm:h-full fills the bounded flex-1 container from App.jsx.
    // Mobile: no height constraint, content flows and the page scrolls.
    <div style={cardStyle} className="flex flex-col bg-gray-900 rounded-xl border border-gray-800 sm:h-full">

      {/* Toolbar */}
      <div className="flex-none px-4 py-3 border-b border-gray-800 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.099zm-5.242 1.156a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z"/>
            </svg>
            <input
              type="text"
              value={search}
              onChange={function(e) { setSearch(e.target.value); }}
              placeholder="Search clients..."
              className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-8 pr-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
          </div>
          <button
            onClick={function() { setShowSettings(function(v) { return !v; }); }}
            title="Column settings"
            className={'p-1.5 rounded-lg border transition-colors ' + (showSettings ? 'bg-blue-900/40 border-blue-600/50 text-blue-300' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500')}
          >
            <svg viewBox="0 0 16 16" className="w-4 h-4" fill="currentColor">
              <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"/>
              <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.474l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115l.094-.319z"/>
            </svg>
          </button>
          {!isDefaultSort && (
            <button
              onClick={resetSort}
              title="Reset sort"
              className="p-1.5 rounded-lg border bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors"
            >
              <svg viewBox="0 0 16 16" className="w-4 h-4" fill="currentColor">
                <path fillRule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/>
                <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/>
              </svg>
            </button>
          )}
          {hasFilter && (
            <button
              onClick={clearAll}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors whitespace-nowrap"
            >
              Clear filters
            </button>
          )}
        </div>

        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {chips.map(function(chip, i) {
              return (
                <span key={i} className="inline-flex items-center gap-1 bg-blue-900/40 border border-blue-700/50 text-blue-300 text-xs rounded-full px-2 py-0.5">
                  {chip.label}
                  <button onClick={chip.remove} className="text-blue-400 hover:text-blue-200 leading-none">&times;</button>
                </span>
              );
            })}
          </div>
        )}

        {showSettings && (
          <ColumnSettingsPanel
            columns={columns}
            onChange={setColumns}
            onClose={function() { setShowSettings(false); }}
          />
        )}
      </div>

      {/* Table scroll container */}
      <div className="flex-1 overflow-y-auto" style={scrollDivStyle}>
        <table style={{ width: tableWidth, tableLayout: isMobile ? 'auto' : 'fixed', borderCollapse: 'collapse' }}>
          <thead className="sticky top-0 z-10 bg-gray-900">
            <tr className="border-b border-gray-800">
              {visibleCols.map(function(col) {
                const sortable = SORTABLE.has(col.id);
                const style    = isMobile ? {} : { width: getWidth(col) + 'px', minWidth: getWidth(col) + 'px', maxWidth: getWidth(col) + 'px', position: 'relative' };
                return (
                  <th
                    key={col.id}
                    style={style}
                    onClick={sortable ? function(e) { toggleSort(col.id, e); } : undefined}
                    className={
                      'px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider select-none overflow-hidden text-ellipsis whitespace-nowrap ' +
                      (sortable ? 'cursor-pointer hover:text-gray-300' : '')
                    }
                  >
                    {col.label}{sortMark(col.id)}
                    {!isMobile && sortable && (
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
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={visibleCols.length} className="px-3 py-8 text-center text-gray-600 text-sm">
                  {hasFilter ? 'No clients match the current filter.' : 'No clients connected.'}
                </td>
              </tr>
            ) : (
              sorted.map(function(c) {
                const isDisc    = c.connectionType === 'discovered';
                const rowClass  = 'border-b border-gray-800/50 transition-colors ' +
                  (isDisc ? 'hover:bg-amber-900/10' : c.isMeshNode ? 'hover:bg-indigo-900/10' : 'hover:bg-gray-800/40');
                return (
                  <tr key={c.mac} className={rowClass}>
                    {visibleCols.map(function(col) { return renderCell(c, col); })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div className="flex-none px-4 py-2 border-t border-gray-800 flex items-center justify-between">
        <span className="text-xs text-gray-600">
          {sorted.length === clients.length
            ? clients.length + ' client' + (clients.length !== 1 ? 's' : '')
            : sorted.length + ' of ' + clients.length + ' clients'}
        </span>
        <span className="text-xs text-gray-700">Shift+click column header for single-column sort</span>
      </div>
    </div>
  );
}
