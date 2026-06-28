'use strict';

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

export const DEFAULT_COLUMNS = [
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

export const SORTABLE = new Set([
  'mac', 'vendor', 'hostname', 'ip', 'apName', 'iface',
  'rssi', 'tx_bytes', 'rx_bytes', 'first_seen', 'reachable',
]);

export const DEFAULT_SORT  = [{ key: 'ip', dir: 'asc' }];
export const MIN_COL_WIDTH = 50;
export const MOBILE_BP     = 640; // px, matches Tailwind sm:

// ---------------------------------------------------------------------------
// localStorage keys
// ---------------------------------------------------------------------------

const LS_COLS_KEY   = 'zenwifi_columns_v1';
const LS_WIDTHS_KEY = 'zenwifi_col_widths_v1';
const LS_SORT_KEY   = 'zenwifi_sort_v1';

// ---------------------------------------------------------------------------
// matchMedia singleton -- avoids spurious breakpoint flips caused by mobile
// browser chrome reflows (address bar, keyboard). The CSS engine drives this,
// so it always agrees with what Tailwind's sm: breakpoint sees.
// ---------------------------------------------------------------------------

var _mq = null;
export function getMq() {
  if (!_mq && typeof window !== 'undefined') {
    _mq = window.matchMedia('(max-width: ' + (MOBILE_BP - 1) + 'px)');
  }
  return _mq;
}

// ---------------------------------------------------------------------------
// Column prefs
// ---------------------------------------------------------------------------

export function loadColumnPrefs() {
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

export function saveColumnPrefs(cols) {
  try {
    localStorage.setItem(LS_COLS_KEY, JSON.stringify(
      cols.map(function(c) { return { id: c.id, visible: c.visible, mobileVisible: c.mobileVisible }; })
    ));
  } catch (_e) {}
}

// ---------------------------------------------------------------------------
// Column width prefs
// ---------------------------------------------------------------------------

export function loadWidthPrefs() {
  try {
    const raw = localStorage.getItem(LS_WIDTHS_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch (_e) { return {}; }
}

export function saveWidthPrefs(widths) {
  try { localStorage.setItem(LS_WIDTHS_KEY, JSON.stringify(widths)); } catch (_e) {}
}

// ---------------------------------------------------------------------------
// Sort prefs
// ---------------------------------------------------------------------------

export function loadSortPrefs() {
  try {
    const raw = localStorage.getItem(LS_SORT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed;
  } catch (_e) { return null; }
}

export function saveSortPrefs(sort) {
  try { localStorage.setItem(LS_SORT_KEY, JSON.stringify(sort)); } catch (_e) {}
}
