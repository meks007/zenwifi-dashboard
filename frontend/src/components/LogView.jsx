import { useRef, useEffect, useLayoutEffect, useState } from 'react';

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

// How close to the bottom (px) before we consider the user "at the bottom".
const BOTTOM_THRESHOLD = 60;

function splitTextTokens(text) {
  var parts = [];
  var re    = /\b([0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2})\b|\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/gi;
  var last  = 0;
  var match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push({ type: 'text', value: text.slice(last, match.index) });
    if (match[1]) {
      parts.push({ type: 'mac', value: match[1] });
    } else {
      parts.push({ type: 'ip', value: match[2] });
    }
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  return parts;
}

function parseMsg(msg) {
  var parts     = [];
  var re        = /\[([^\]]+)\]/g;
  var last      = 0;
  var match;
  var firstUnit = false;

  while ((match = re.exec(msg)) !== null) {
    if (match.index > last) {
      splitTextTokens(msg.slice(last, match.index)).forEach(function(p) { parts.push(p); });
    }
    if (!firstUnit) {
      parts.push({ type: 'unit', value: match[0], tag: match[1] });
      firstUnit = true;
    } else {
      parts.push({ type: 'text', value: match[0] });
    }
    last = re.lastIndex;
  }
  if (last < msg.length) {
    splitTextTokens(msg.slice(last)).forEach(function(p) { parts.push(p); });
  }
  return parts;
}

export default function LogView({ logs, filter, onFilterChange, search, onSearchChange, onRequestHistory }) {
  // autoScroll is the canonical source of truth.
  // true  = follow tail (we pin to bottom after every render)
  // false = user scrolled up, we leave the viewport alone
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef(null);

  // We need to know whether the *next* scroll event is ours or the user's.
  // We set this to true immediately before we programmatically set scrollTop,
  // and clear it in the scroll handler.
  const ownScrollRef = useRef(false);

  const filtered = logs.filter(function(entry) {
    if (filter !== 'all' && entry.level !== filter) return false;
    if (search && !entry.msg.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // After every render where autoScroll is on, instantly pin to the bottom.
  // useLayoutEffect fires synchronously after DOM mutations, before the browser
  // paints, so the scroll position is set before the user ever sees the frame.
  // This is the only reliable way to keep up with rapid log activity.
  useLayoutEffect(function() {
    if (!autoScroll) return;
    var el = scrollRef.current;
    if (!el) return;
    ownScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
  });

  function handleScroll() {
    // If this scroll event was triggered by us, ignore it.
    if (ownScrollRef.current) {
      ownScrollRef.current = false;
      return;
    }
    var el = scrollRef.current;
    if (!el) return;
    var distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    var atBottom = distFromBottom < BOTTOM_THRESHOLD;
    setAutoScroll(atBottom);
  }

  function resumeFollow() {
    // Set state first so the layout effect fires on the next render and pins us.
    setAutoScroll(true);
    // Also do an immediate jump so there is zero visible delay.
    var el = scrollRef.current;
    if (el) {
      ownScrollRef.current = true;
      el.scrollTop = el.scrollHeight;
    }
  }

  function formatTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
    } catch (_) {
      return iso;
    }
  }

  function handleTokenClick(value) {
    onSearchChange(search === value ? '' : value);
  }

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden flex flex-col sm:h-full w-full">
      {/* Toolbar */}
      <div className="px-4 py-3 border-b border-gray-800 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-gray-300 mr-2">Log Output</h2>

        {/* Level filter */}
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

        {/* History buttons */}
        {onRequestHistory && (
          <div className="flex gap-1">
            <button
              onClick={function() { onRequestHistory(500); }}
              className="text-xs px-2.5 py-1 rounded-md font-medium bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
              title="Request last 500 log lines from server"
            >
              Load 500
            </button>
            <button
              onClick={function() { onRequestHistory(0); }}
              className="text-xs px-2.5 py-1 rounded-md font-medium bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
              title="Request full log history from server (all rotated files)"
            >
              Load all
            </button>
          </div>
        )}

        {/* Search */}
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

        {/* Follow indicator / Resume button */}
        {autoScroll ? (
          <span className="text-xs text-gray-500 select-none whitespace-nowrap">Following</span>
        ) : (
          <button
            onClick={resumeFollow}
            className="text-xs px-2.5 py-1 rounded-md font-medium bg-blue-700/40 text-blue-300 hover:bg-blue-600/60 transition-colors whitespace-nowrap"
          >
            Resume &darr;
          </button>
        )}
      </div>

      {/* Log lines */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-mono text-xs"
      >
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
                        onClick={function() { handleTokenClick(part.tag); }}
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
                  if (part.type === 'mac') {
                    var macActive = search === part.value;
                    return (
                      <button
                        key={pi}
                        onClick={function() { handleTokenClick(part.value); }}
                        title={macActive ? 'Clear filter' : 'Filter by MAC ' + part.value}
                        className={
                          'font-mono rounded px-0.5 transition-colors ' +
                          (macActive
                            ? 'bg-purple-600/40 text-purple-200 ring-1 ring-purple-500/50'
                            : 'text-purple-400 hover:bg-purple-900/40 hover:text-purple-200')
                        }
                      >
                        {part.value}
                      </button>
                    );
                  }
                  if (part.type === 'ip') {
                    var ipActive = search === part.value;
                    return (
                      <button
                        key={pi}
                        onClick={function() { handleTokenClick(part.value); }}
                        title={ipActive ? 'Clear filter' : 'Filter by IP ' + part.value}
                        className={
                          'font-mono rounded px-0.5 transition-colors ' +
                          (ipActive
                            ? 'bg-green-600/40 text-green-200 ring-1 ring-green-500/50'
                            : 'text-green-400 hover:bg-green-900/40 hover:text-green-200')
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
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-gray-800 text-xs text-gray-600 flex items-center gap-3">
        <span>{filtered.length} of {logs.length} entries</span>
        {search && <span className="text-blue-500/70">filtered by &ldquo;{search}&rdquo;</span>}
        {!autoScroll && (
          <button
            onClick={resumeFollow}
            className="ml-auto text-blue-400 hover:text-blue-200 transition-colors"
          >
            Scroll to bottom &darr;
          </button>
        )}
      </div>
    </div>
  );
}
