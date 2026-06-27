import { useState, useEffect, useRef, useCallback } from 'react';
import ClientTable from './components/ClientTable.jsx';
import StatusBar from './components/StatusBar.jsx';

const WS_URL = 'ws://' + window.location.host + '/ws';
const RECONNECT_DELAY_MS = 3000;

export default function App() {
  const [clients, setClients] = useState([]);
  const [apStatus, setApStatus] = useState({});
  const [mqttConnected, setMqttConnected] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [disconnecting, setDisconnecting] = useState({});
  const [toast, setToast] = useState(null);
  const wsRef = useRef(null);

  const showToast = useCallback(function(msg, type) {
    setToast({ msg, type });
    setTimeout(function() { setToast(null); }, 3500);
  }, []);

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
        if (data.type === 'disconnect_result') {
          setDisconnecting(function(d) { const n = Object.assign({}, d); delete n[data.mac]; return n; });
          if (data.success) {
            showToast('Client ' + data.mac + ' disconnected.', 'success');
          } else {
            showToast('Failed: ' + data.error, 'error');
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

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-sans">
      <header className="bg-gray-900 border-b border-gray-800 px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center text-white font-bold text-sm">ZW</div>
          <h1 className="text-lg font-semibold tracking-tight">Zenwifi Dashboard</h1>
        </div>
        <div className="flex items-center gap-2 text-sm text-gray-400">
          {lastUpdated && (
            <span>Updated {new Date(lastUpdated).toLocaleTimeString()}</span>
          )}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-5">
        <StatusBar
          wsConnected={wsConnected}
          mqttConnected={mqttConnected}
          apStatus={apStatus}
          clientCount={clients.length}
        />
        <ClientTable
          clients={clients}
          disconnecting={disconnecting}
          onDisconnect={handleDisconnect}
        />
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
