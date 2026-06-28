import { useState, useEffect } from 'react';
import {
  DEFAULT_COLUMNS, DEFAULT_SORT, MIN_COL_WIDTH, SORTABLE,
  getMq, loadColumnPrefs, saveColumnPrefs, loadWidthPrefs, saveWidthPrefs,
  loadSortPrefs, saveSortPrefs,
} from './clientTableConfig.js';
import { compareByKey, macOui } from './clientTableUtils.js';
import { ColumnSettingsPanel, ResizeHandle } from './ClientTableControls.jsx';
import ClientTableCell from './ClientTableCell.jsx';

export default function ClientTable({ clients, disconnecting, onDisconnect, pinging, onPing }) {
  const [search, setSearch]           = useState('');
  const [sortCols, setSortCols]       = useState(function() { return loadSortPrefs() || DEFAULT_SORT; });
  const [activeAps, setActiveAps]     = useState(new Set());
  const [activeVendors, setActiveVendors] = useState(new Set());
  const [activeOuis, setActiveOuis]   = useState(new Set());
  const [meshOnly, setMeshOnly]       = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const [isMobile, setIsMobile] = useState(function() { var mq = getMq(); return mq ? mq.matches : false; });
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
  function handleResizeDone() { setColWidths(function(w) { saveWidthPrefs(w); return w; }); }

  useEffect(function() { saveColumnPrefs(columns); }, [columns]);
  useEffect(function() { saveSortPrefs(sortCols); }, [sortCols]);

  const [, setTick] = useState(0);
  useEffect(function() {
    const id = setInterval(function() { setTick(function(n) { return n + 1; }); }, 30000);
    return function() { clearInterval(id); };
  }, []);

  const visibleCols  = columns.filter(function(c) { return isMobile ? c.mobileVisible : c.visible; });
  const tableWidth   = isMobile ? 'auto' : visibleCols.reduce(function(sum, c) { return sum + getWidth(c); }, 0) + 'px';

  function toggleFacet(setter, value) {
    setter(function(prev) {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  }

  function toggleSort(key, e) {
    setSortCols(function(prev) {
      const single   = e && e.shiftKey;
      const existing = prev.find(function(s) { return s.key === key; });
      if (single) {
        if (existing) {
          if (existing.dir === 'asc') return [{ key: key, dir: 'desc' }];
          return DEFAULT_SORT;
        }
        return [{ key: key, dir: 'asc' }];
      }
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
        {sortCols.length > 1 ? <sub>{idx + 1}</sub> : null}
      </span>
    );
  }

  function clearAll() {
    setSearch(''); setActiveAps(new Set()); setActiveVendors(new Set()); setActiveOuis(new Set()); setMeshOnly(false);
  }

  const q        = search.trim().toLowerCase();
  const filtered = clients.filter(function(c) {
    if (meshOnly && !c.isMeshNode) return false;
    if (q) {
      const hit = (c.mac && c.mac.toLowerCase().includes(q)) ||
        (c.vendor && c.vendor.toLowerCase().includes(q)) ||
        (c.hostname && c.hostname.toLowerCase().includes(q)) ||
        (c.ip && c.ip.toLowerCase().includes(q)) ||
        (c.apName && c.apName.toLowerCase().includes(q)) ||
        (c.iface && c.iface.toLowerCase().includes(q));
      if (!hit) return false;
    }
    if (activeAps.size > 0 && !activeAps.has(c.apName)) return false;
    if (activeVendors.size > 0 && !activeVendors.has(c.vendor)) return false;
    if (activeOuis.size > 0 && !activeOuis.has(macOui(c.mac))) return false;
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
  activeAps.forEach(function(v)      { chips.push({ label: 'AP: ' + v,     remove: function() { toggleFacet(setActiveAps, v); } }); });
  activeVendors.forEach(function(v)  { chips.push({ label: 'Vendor: ' + v, remove: function() { toggleFacet(setActiveVendors, v); } }); });
  activeOuis.forEach(function(v)     { chips.push({ label: 'OUI: ' + v,    remove: function() { toggleFacet(setActiveOuis, v); } }); });

  const cardStyle      = isMobile ? { width: '100%', minWidth: 0, overflowX: 'auto' } : { width: '102%', minWidth: '400px', overflowX: 'auto' };
  const scrollDivStyle = isMobile ? {} : { scrollbarWidth: 'thin', scrollbarColor: '#374151 transparent' };

  return (
    <div className="sm:h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-1 py-2 flex-shrink-0">
        <input
          type="text" value={search} onChange={function(e) { setSearch(e.target.value); }}
          placeholder="Search..."
          className="flex-1 min-w-[140px] bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        <button onClick={function() { setMeshOnly(function(v) { return !v; }); }}
          className={'text-xs px-3 py-1.5 rounded border transition-colors ' + (meshOnly ? 'bg-indigo-900/50 border-indigo-600/60 text-indigo-300' : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700')}>
          Mesh only
        </button>
        {!isDefaultSort && (
          <button onClick={resetSort} className="text-xs px-3 py-1.5 rounded border bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700 transition-colors">
            Reset sort
          </button>
        )}
        {hasFilter && (
          <button onClick={clearAll} className="text-xs px-3 py-1.5 rounded border bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700 transition-colors">
            Clear filters
          </button>
        )}
        <button onClick={function() { setShowSettings(function(v) { return !v; }); }}
          className={'text-xs px-3 py-1.5 rounded border transition-colors ' + (showSettings ? 'bg-blue-900/50 border-blue-600/60 text-blue-300' : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700')}>
          Columns
        </button>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1 pb-2 flex-shrink-0">
          {chips.map(function(chip, i) {
            return (
              <span key={i} className="inline-flex items-center gap-1 text-xs bg-blue-900/30 border border-blue-700/40 text-blue-300 rounded-full px-2 py-0.5">
                {chip.label}
                <button onClick={chip.remove} className="hover:text-white leading-none">&times;</button>
              </span>
            );
          })}
        </div>
      )}

      {showSettings && (
        <ColumnSettingsPanel columns={columns} setColumns={setColumns} defaultColumns={DEFAULT_COLUMNS} />
      )}

      {/* Table scroll container */}
      <div className="flex-1 sm:overflow-y-auto" style={scrollDivStyle}>
        <div style={cardStyle}>
          <table className="border-collapse text-left" style={{ width: tableWidth, tableLayout: isMobile ? 'auto' : 'fixed' }}>
            <thead className="sticky top-0 z-10 bg-gray-900">
              <tr>
                {visibleCols.map(function(col) {
                  const sortable = SORTABLE.has(col.id);
                  const style    = isMobile ? {} : { width: getWidth(col) + 'px', minWidth: getWidth(col) + 'px', maxWidth: getWidth(col) + 'px', position: 'relative' };
                  return (
                    <th key={col.id} className="px-3 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider border-b border-gray-700 whitespace-nowrap select-none" style={style}>
                      <span onClick={sortable ? function(e) { toggleSort(col.id, e); } : undefined} className={sortable ? 'cursor-pointer hover:text-gray-200' : ''}>
                        {col.label}{sortMark(col.id)}
                      </span>
                      {!isMobile && sortable && (
                        <ResizeHandle colId={col.id} onResize={handleResize} onDone={handleResizeDone} />
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={visibleCols.length} className="px-3 py-8 text-center text-gray-500 text-sm">
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
                      {visibleCols.map(function(col) {
                        return (
                          <ClientTableCell
                            key={col.id}
                            client={c}
                            col={col}
                            isMobile={isMobile}
                            colWidth={getWidth(col)}
                            meshOnly={meshOnly}
                            activeAps={activeAps}
                            activeVendors={activeVendors}
                            activeOuis={activeOuis}
                            disconnecting={disconnecting}
                            onDisconnect={onDisconnect}
                            pinging={pinging}
                            onPing={onPing}
                            onMeshToggle={function() { setMeshOnly(true); }}
                            onApToggle={function(v) { toggleFacet(setActiveAps, v); }}
                            onVendorToggle={function(v) { toggleFacet(setActiveVendors, v); }}
                            onOuiToggle={function(v) { toggleFacet(setActiveOuis, v); }}
                          />
                        );
                      })}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-1 py-1.5 text-xs text-gray-600 flex-shrink-0 border-t border-gray-800">
        <span>
          {sorted.length === clients.length
            ? clients.length + ' client' + (clients.length !== 1 ? 's' : '')
            : sorted.length + ' of ' + clients.length + ' clients'}
        </span>
        <span>Shift+click column header for single-column sort</span>
      </div>
    </div>
  );
}
