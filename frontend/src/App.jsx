import { useState, useEffect, useRef, useCallback } from 'react';
import ClientTable from './components/ClientTable.jsx';
import StatusBar from './components/StatusBar.jsx';
import LogView from './components/LogView.jsx';

const WS_URL           = 'ws://' + window.location.host + '/ws';
const RECONNECT_DELAY_MS = 3000;
const MAX_LOG_ENTRIES  = 50000;

export default function App() {
  const [clients, setClients]           = useState([]);
  const [apStatus, setApStatus]         = useState({});
  const [mqttConnected, setMqttConnected] = useState(false);
  const [wsConnected, setWsConnected]   = useState(false);
  const [dbHealthy, setDbHealthy]       = useState(true);
  const [lastUpdated, setLastUpdated]   = useState(null);
  const [disconnecting, setDisconnecting] = useState({});
  const [pinging, setPinging]           = useState({});
  const [toast, setToast]               = useState(null);
  const [logs, setLogs]                 = useState([]);
  const [activeTab, setActiveTab]       = useState('clients');
  const [version, setVersion]           = useState(null);
  const [repoUrl, setRepoUrl]           = useState(null);
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
        if (data.type === 'db_status')   { setDbHealthy(!!data.healthy); }
        if (data.type === 'log')         { appendLog(data.entry); }
        if (data.type === 'log_history') { setLogs(data.logs || []); }
        if (data.type === 'disconnect_result') {
          setDisconnecting(function(d) { const n = Object.assign({}, d); delete n[data.mac]; return n; });
          if (data.success) showToast('Client ' + data.mac + ' disconnected.', 'success');
          else              showToast('Failed to disconnect ' + data.mac + ': ' + data.error, 'error');
        }
      } catch (_e) {}
    };
    ws.onclose = function() { setWsConnected(false); setTimeout(connectWS, RECONNECT_DELAY_MS); };
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

  const handlePing = useCallback(function(mac) {
    setPinging(function(d) { return Object.assign({}, d, { [mac]: true }); });
    fetch('/api/ping', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ mac: mac }),
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        setPinging(function(d) { const n = Object.assign({}, d); delete n[mac]; return n; });
        if (data.success) {
          var label = data.online ? 'online' : 'offline';
          showToast(mac + ' is ' + label + ' (' + data.result + ')', data.online ? 'success' : 'error');
        } else {
          showToast('Ping failed for ' + mac + ': ' + data.error, 'error');
        }
      })
      .catch(function(err) {
        setPinging(function(d) { const n = Object.assign({}, d); delete n[mac]; return n; });
        showToast('Ping request failed: ' + err.message, 'error');
      });
  }, [showToast]);

  const errorCount = logs.filter(function(l) { return l.level === 'error'; }).length;
  const tabs = [
    { id: 'clients', label: 'Clients (' + clients.length + ')' },
    { id: 'logs',    label: 'Logs' + (errorCount > 0 ? ' (' + errorCount + ' errors)' : '') },
  ];

  return (
    <div className="min-h-screen sm:h-screen bg-gray-950 text-gray-100 flex flex-col font-sans">
      <header className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-gray-900">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold tracking-tight text-white bg-blue-600 rounded px-2 py-0.5">ZW</span>
          <h1 className="text-base font-semibold text-gray-100">Zenwifi Dashboard</h1>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {lastUpdated && 'Updated ' + new Date(lastUpdated).toLocaleTimeString()}
          {version && (
            <span className="bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-gray-400">{version}</span>
          )}
          {repoUrl && (
            <a href={repoUrl} target="_blank" rel="noreferrer" className="hover:text-gray-300 transition-colors">
              GitHub
            </a>
          )}
        </div>
      </header>

      <StatusBar wsConnected={wsConnected} mqttConnected={mqttConnected} dbHealthy={dbHealthy} apStatus={apStatus} />

      <nav className="flex-shrink-0 flex gap-1 px-4 pt-2 border-b border-gray-800 bg-gray-900">
        {tabs.map(function(tab) {
          return (
            <button key={tab.id} onClick={function() { setActiveTab(tab.id); }}
              className={'px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ' +
                (activeTab === tab.id ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-300')}>
              {tab.label}
            </button>
          );
        })}
      </nav>

      <div className="flex-1 sm:overflow-hidden px-4 py-3">
        {activeTab === 'clients' && (
          <ClientTable
            clients={clients}
            disconnecting={disconnecting}
            onDisconnect={handleDisconnect}
            pinging={pinging}
            onPing={handlePing}
          />
        )}
        {activeTab === 'logs' && (
          <LogView logs={logs} />
        )}
      </div>

      {toast && (
        <div className={'fixed bottom-4 right-4 z-50 px-4 py-3 rounded shadow-lg text-sm font-medium transition-all ' +
          (toast.type === 'success' ? 'bg-green-800 text-green-100' : 'bg-red-800 text-red-100')}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
