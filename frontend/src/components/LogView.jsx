import { useRef, useEffect, useState } from 'react';

const LEVEL_COLORS = {
  info:  'text-blue-300',
  warn:  'text-yellow-300',
  error: 'text-red-400',
  debug: 'text-gray-500',
};

const LEVEL_BG = {
  info:  '',
  warn:  'bg-yellow-900/20',
  error: 'bg-red-900/20',
  debug: '',
};

// Parse a log message into alternating plain-text and [UNIT] segments.
// Returns an array of { type: 'text'|'unit', value: string }.
function parseMsg(msg) {
  var parts  = [];
  var re     = /\[([^\]]+)\]/g;
  var last   = 0;
  var match;
  while ((match = re.exec(msg)) !== null) {
    if (match.index > last) parts.push({ type: 'text', value: msg.slice(last, match.index) });
    parts.push({ type: 'unit', value: match[0], tag: match[1] });
    last = re.lastIndex;
  }
  if (last < msg.length) parts.push({ type: 'text', value: msg.slice(last) });
  return parts;
}

export default function LogView({ logs, filter, onFilterChange, search, onSearchChange }) {
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef(null);

  const filtered = logs.filter(function(entry) {
    if (filter !== 'all' && entry.level !== filter) return false;
    if (search && !entry.msg.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  useEffect(function() {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  function formatTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
    } catch (_) {
      return iso;
    }
  }

  // Clicking a [UNIT] tag sets the search filter to that tag text.
  // Clicking the same tag again clears the filter.
  function handleUnitClick(tag) {
    onSearchChange(search === tag ? '' : tag);
  }

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden flex flex-col sm:h-full w-full">
      <div className="px-4 py-3 border-b border-gray-800 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-gray-300 mr-2">Log Output</h2>

        <div className="flex gap-1">
          {['all', 'info', 'warn', 'error', 'debug'].map(function(lvl) {
            return (
              <button
                key={lvl}
                onClick={function() { onFilterChange(lvl); }}
                className={
                  'text-xs px-2.5 py-1 rounded-md font-medium transition-colors capitalize ' +
                  (filter === lvl
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-200')
                }
              >
                {lvl}
              </button>
            );
          })}
        </div>

        <div className="ml-auto relative">
          <input
            type="text"
            placeholder="Filter messages..."
            value={search}
            onChange={function(e) { onSearchChange(e.target.value); }}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 w-48"
          />
          {search && (
            <button
              onClick={function() { onSearchChange(''); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 leading-none"
              title="Clear filter"
            >
              &times;
            </button>
          )}
        </div>

        <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={function(e) { setAutoScroll(e.target.checked); }}
            className="rounded"
          />
          Auto-scroll
        </label>
      </div>

      <div className="flex-1 overflow-y-auto font-mono text-xs">
        {filtered.length === 0 && (
          <div className="px-4 py-10 text-center text-gray-600">No log entries.</div>
        )}
        {filtered.map(function(entry, idx) {
          var parts = parseMsg(entry.msg);
          return (
            <div
              key={idx}
              className={'flex gap-3 px-4 py-0.5 border-b border-gray-800/50 hover:bg-gray-800/30 ' + (LEVEL_BG[entry.level] || '')}
            >
              <span className="text-gray-600 whitespace-nowrap shrink-0">{formatTime(entry.ts)}</span>
              <span className={'uppercase w-10 shrink-0 font-semibold ' + (LEVEL_COLORS[entry.level] || 'text-gray-300')}>
                {entry.level.substring(0, 4)}
              </span>
              <span className="text-gray-300 break-all">
                {parts.map(function(part, pi) {
                  if (part.type === 'unit') {
                    var active = search === part.tag;
                    return (
                      <button
                        key={pi}
                        onClick={function() { handleUnitClick(part.tag); }}
                        title={active ? 'Clear filter' : 'Filter by ' + part.value}
                        className={
                          'font-semibold rounded px-0.5 transition-colors ' +
                          (active
                            ? 'bg-blue-600/40 text-blue-200 ring-1 ring-blue-500/50'
                            : 'text-blue-400 hover:bg-blue-900/40 hover:text-blue-200')
                        }
                      >
                        {part.value}
                      </button>
                    );
                  }
                  return <span key={pi}>{part.value}</span>;
                })}
              </span>
              {entry.meta && (
                <span className="text-gray-600 ml-auto shrink-0 pl-2">{JSON.stringify(entry.meta)}</span>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="px-4 py-2 border-t border-gray-800 text-xs text-gray-600">
        {filtered.length} of {logs.length} entries
        {search && <span className="ml-2 text-blue-500/70">filtered by &ldquo;{search}&rdquo;</span>}
      </div>
    </div>
  );
}
