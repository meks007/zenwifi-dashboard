import { useState, useEffect, useRef, useCallback } from 'react';
import ClientTable from './components/ClientTable.jsx';
import StatusBar from './components/StatusBar.jsx';
import LogView from './components/LogView.jsx';

const WS_URL = 'ws://' + window.location.host + '/ws';
const RECONNECT_DELAY_MS = 3000;

const MAX_LOG_ENTRIES = 50000;

export default function App() {
  const [clients, setClients] = useState([]);
  const [apStatus, setApStatus] = useState({});
  const [mqttConnected, setMqttConnected] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [disconnecting, setDisconnecting] = useState({});
  const [toast, setToast] = useState(null);
  const [logs, setLogs] = useState([]);
  const [activeTab, setActiveTab] = useState('clients');
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
          setLastUpdated(data.timestamp);
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
    { id: 'logs', label: 'Logs' + (errorCount > 0 ? ' (' + errorCount + ' errors)' : '') },
  ];

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-sans">
      <header className="bg-gray-900 border-b border-gray-800 px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center text-white font-bold text-sm">ZW</div>
          <h1 className="text-lg font-semibold tracking-tight">Zenwifi Dashboard</h1>
        </div>
        <div className="text-sm text-gray-500">
          {lastUpdated && 'Updated ' + new Date(lastUpdated).toLocaleTimeString()}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-5">
        <StatusBar
          wsConnected={wsConnected}
          mqttConnected={mqttConnected}
          apStatus={apStatus}
          clientCount={clients.length}
        />

        <div className="flex gap-1 border-b border-gray-800">
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
