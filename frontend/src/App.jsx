import { useState, useEffect, useRef, useCallback } from 'react';
import ClientTable from './components/ClientTable.jsx';
import StatusBar from './components/StatusBar.jsx';
import LogView from './components/LogView.jsx';

const WS_URL          = 'ws://' + window.location.host + '/ws';
const RECONNECT_DELAY_MS = 3000;
const MAX_LOG_ENTRIES = 50000;

export default function App() {
  const [clients, setClients]             = useState([]);
  const [apStatus, setApStatus]           = useState({});
  const [mqttConnected, setMqttConnected] = useState(false);
  const [wsConnected, setWsConnected]     = useState(false);
  const [dbHealthy, setDbHealthy]         = useState(true);
  const [lastUpdated, setLastUpdated]     = useState(null);
  const [disconnecting, setDisconnecting] = useState({});
  const [toast, setToast]                 = useState(null);
  const [logs, setLogs]                   = useState([]);
  const [activeTab, setActiveTab]         = useState('clients');
  const [version, setVersion]             = useState(null);
  const [repoUrl, setRepoUrl]             = useState(null);
  const wsRef = useRef(null);

  const showToast = useCallback(function(msg, type) {
    setToast({ msg, type });
    setTimeout(function() { setToast(null); }, 3500);
  }, []);

  function appendLog(entry) {
    setLogs(function(prev) {
      const next = prev.concat(entry);
      return next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next;
    });
  }

  const connectWS = useCallback(function() {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = function() { setWsConnected(true); };

    ws.onmessage = function(event) {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'clients') {
          setClients(data.clients || []);
          setApStatus(data.apStatus || {});
          setMqttConnected(!!data.mqttConnected);
          if (typeof data.dbHealthy === 'boolean') setDbHealthy(data.dbHealthy);
          setLastUpdated(data.timestamp);
          if (data.version) setVersion('v' + data.version);
          if (data.repoUrl) setRepoUrl(data.repoUrl);
        }

        if (data.type === 'db_status') {
          setDbHealthy(!!data.healthy);
        }

        if (data.type === 'log') {
          appendLog(data.entry);
        }

        if (data.type === 'log_history') {
          setLogs(data.logs || []);
        }

        if (data.type === 'disconnect_result') {
          setDisconnecting(function(d) {
            const n = Object.assign({}, d);
            delete n[data.mac];
            return n;
          });
          if (data.success) {
            showToast('Client ' + data.mac + ' disconnected.', 'success');
          } else {
            showToast('Failed to disconnect ' + data.mac + ': ' + data.error, 'error');
          }
        }
      } catch (_e) {}
    };

    ws.onclose = function() {
      setWsConnected(false);
      setTimeout(connectWS, RECONNECT_DELAY_MS);
    };

    ws.onerror = function() { ws.close(); };
  }, [showToast]);

  useEffect(function() {
    connectWS();
    return function() { if (wsRef.current) wsRef.current.close(); };
  }, [connectWS]);

  const handleDisconnect = useCallback(function(mac) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setDisconnecting(function(d) { return Object.assign({}, d, { [mac]: true }); });
    wsRef.current.send(JSON.stringify({ type: 'disconnect', mac: mac }));
  }, []);

  const errorCount = logs.filter(function(l) { return l.level === 'error'; }).length;

  const tabs = [
    { id: 'clients', label: 'Clients (' + clients.length + ')' },
    { id: 'logs',    label: 'Logs' + (errorCount > 0 ? ' (' + errorCount + ' errors)' : '') },
  ];

  return (
    // Desktop (sm+): locked to screen height, internal scroll only.
    // Mobile: min-h-screen, no height lock -- the page scrolls naturally.
    <div className="flex flex-col bg-gray-950 text-gray-100 font-sans min-h-screen sm:h-screen sm:overflow-hidden">
      <header className="flex-none bg-gray-900 border-b border-gray-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center text-white font-bold text-sm">ZW</div>
          <h1 className="text-lg font-semibold tracking-tight">Zenwifi Dashboard</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">
            {lastUpdated && 'Updated ' + new Date(lastUpdated).toLocaleTimeString()}
          </span>
          {version && (
            <span className="text-xs text-gray-600 border border-gray-700 rounded px-1.5 py-0.5 font-mono">{version}</span>
          )}
          {repoUrl && (
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="View on GitHub"
              className="text-gray-500 hover:text-gray-200 transition-colors"
            >
              <svg viewBox="0 0 16 16" className="w-5 h-5" fill="currentColor" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
                         0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
                         -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66
                         .07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15
                         -.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27
                         .68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12
                         .51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48
                         0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
              </svg>
            </a>
          )}
        </div>
      </header>

      <main className="flex-1 flex flex-col sm:overflow-hidden px-4 pt-3">
        <div className="flex-none">
          <StatusBar
            wsConnected={wsConnected}
            mqttConnected={mqttConnected}
            dbHealthy={dbHealthy}
            apStatus={apStatus}
            clientCount={clients.length}
          />
        </div>

        <div className="flex-none flex gap-1 border-b border-gray-800 mt-3">
          {tabs.map(function(tab) {
            return (
              <button
                key={tab.id}
                onClick={function() { setActiveTab(tab.id); }}
                className={
                  'px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ' +
                  (activeTab === tab.id
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-gray-500 hover:text-gray-300')
                }
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Desktop: flex-1 + sm:overflow-hidden bounds the content to the viewport.
            Mobile: height is unconstrained, the page scrolls naturally. */}
        <div className="flex-1 sm:overflow-hidden py-3 flex justify-center">
          {activeTab === 'clients' && (
            <ClientTable
              clients={clients}
              disconnecting={disconnecting}
              onDisconnect={handleDisconnect}
            />
          )}

          {activeTab === 'logs' && (
            <LogView logs={logs} />
          )}
        </div>
      </main>

      {toast && (
        <div className={
          'fixed bottom-5 right-5 px-4 py-3 rounded-lg shadow-lg text-sm font-medium z-50 ' +
          (toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white')
        }>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
