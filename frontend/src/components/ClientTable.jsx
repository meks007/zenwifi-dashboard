import { useState, useEffect } from 'react';
import {
  DEFAULT_COLUMNS, DEFAULT_SORT, MIN_COL_WIDTH, SORTABLE,
  getMq,
  loadColumnPrefs, saveColumnPrefs,
  loadWidthPrefs,  saveWidthPrefs,
  loadSortPrefs,   saveSortPrefs,
} from './clientTableConfig.js';
import { compareByKey, macOui } from './clientTableUtils.js';
import { ColumnSettingsPanel, ResizeHandle } from './ClientTableControls.jsx';
import ClientTableCell from './ClientTableCell.jsx';

export default function ClientTable({ clients, disconnecting, onDisconnect, pinging, onPing, search, onSearchChange, onLogSearch }) {
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

  // Refresh relative timestamps every 30 s.
  const [, setTick] = useState(0);
  useEffect(function() {
    const id = setInterval(function() { setTick(function(n) { return n + 1; }); }, 30000);
    return function() { clearInterval(id); }
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
      const multi    = e && e.shiftKey;
      const existing = prev.find(function(s) { return s.key === key; });
      if (multi) {
        // Shift+click: add/toggle this column in the multi-sort stack.
        if (existing) {
          if (existing.dir === 'asc') return prev.map(function(s) { return s.key === key ? { key: key, dir: 'desc' } : s; });
          const next = prev.filter(function(s) { return s.key !== key; });
          return next.length > 0 ? next : DEFAULT_SORT;
        }
        return prev.concat([{ key: key, dir: 'asc' }]);
      }
      // Plain click: single-column sort.
      if (existing) {
        if (existing.dir === 'asc') return [{ key: key, dir: 'desc' }];
        return DEFAULT_SORT;
      }
      return [{ key: key, dir: 'asc' }];
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
    onSearchChange('');
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
              placeholder="Search clients..."
              value={search}
              onChange={function(e) { onSearchChange(e.target.value); }}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-8 pr-3 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            {search && (
              <button
                onClick={function() { onSearchChange(''); }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                title="Clear search"
              >
                &times;
              </button>
            )}
          </div>

          <button
            onClick={function() { setShowSettings(function(v) { return !v; }); }}
            title="Column settings"
            className={'p-1.5 rounded-lg border transition-colors ' + (showSettings ? 'bg-blue-900/40 border-blue-700 text-blue-300' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200')}
          >
            <svg viewBox="0 0 16 16" className="w-4 h-4" fill="currentColor">
              <path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z"/>
            </svg>
          </button>

          {!isDefaultSort && (
            <button
              onClick={resetSort}
              title="Reset sort"
              className="p-1.5 rounded-lg border bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
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
              className="text-xs px-2 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 transition-colors whitespace-nowrap"
            >
              Clear all
            </button>
          )}
        </div>

        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {chips.map(function(chip, i) {
              return (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 text-xs bg-blue-900/30 border border-blue-700/40 text-blue-300 rounded-full px-2 py-0.5"
                >
                  {chip.label}
                  <button onClick={chip.remove} className="hover:text-white leading-none">&times;</button>
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

      {/* Table scroll area */}
      <div className="flex-1 overflow-y-auto" style={scrollDivStyle}>
        <table style={{ width: tableWidth, tableLayout: isMobile ? 'auto' : 'fixed', borderCollapse: 'collapse' }}>
          <thead className="sticky top-0 bg-gray-900 z-10">
            <tr>
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
                const isDisc   = c.connectionType === 'discovered';
                const rowClass = 'border-b border-gray-800/50 transition-colors ' +
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
                          onMeshToggle={function() { setMeshOnly(function(v) { return !v; }); }}
                          onApToggle={function(v) { toggleFacet(setActiveAps, v); }}
                          onVendorToggle={function(v) { toggleFacet(setActiveVendors, v); }}
                          onOuiToggle={function(v) { toggleFacet(setActiveOuis, v); }}
                          onLogSearch={onLogSearch}
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

      {/* Footer */}
      <div className="flex-none px-4 py-2 border-t border-gray-800 flex items-center justify-between">
        <span className="text-xs text-gray-600">
          {sorted.length === clients.length
            ? clients.length + ' client' + (clients.length !== 1 ? 's' : '')
            : sorted.length + ' of ' + clients.length + ' clients'}
        </span>
        <span className="text-xs text-gray-700">Shift+click column header to add to multi-column sort</span>
      </div>
    </div>
  );
}
