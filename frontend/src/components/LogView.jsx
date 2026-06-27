import { useState, useRef, useEffect } from 'react';

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

export default function LogView({ logs }) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
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

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-gray-800 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-gray-300 mr-2">Log Output</h2>

        <div className="flex gap-1">
          {['all', 'info', 'warn', 'error', 'debug'].map(function(lvl) {
            return (
              <button
                key={lvl}
                onClick={function() { setFilter(lvl); }}
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

        <input
          type="text"
          placeholder="Filter messages..."
          value={search}
          onChange={function(e) { setSearch(e.target.value); }}
          className="ml-auto bg-gray-800 border border-gray-700 rounded-lg px-3 py-1 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 w-48"
        />

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

      <div className="overflow-y-auto font-mono text-xs" style={{ height: '420px' }}>
        {filtered.length === 0 && (
          <div className="px-4 py-10 text-center text-gray-600">No log entries.</div>
        )}
        {filtered.map(function(entry, idx) {
          return (
            <div
              key={idx}
              className={'flex gap-3 px-4 py-0.5 border-b border-gray-800/50 hover:bg-gray-800/30 ' + (LEVEL_BG[entry.level] || '')}
            >
              <span className="text-gray-600 whitespace-nowrap shrink-0">{formatTime(entry.ts)}</span>
              <span className={'uppercase w-10 shrink-0 font-semibold ' + (LEVEL_COLORS[entry.level] || 'text-gray-300')}>
                {entry.level.substring(0, 4)}
              </span>
              <span className="text-gray-300 break-all">{entry.msg}</span>
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
      </div>
    </div>
  );
}
