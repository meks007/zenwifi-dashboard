export default function StatusBar({ wsConnected, mqttConnected, dbHealthy, apStatus, clientCount }) {
  const apEntries = Object.entries(apStatus || {});

  function dot(ok) {
    return ok
      ? 'inline-block w-2 h-2 rounded-full bg-green-400 flex-shrink-0'
      : 'inline-block w-2 h-2 rounded-full bg-red-500 flex-shrink-0';
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">

      <div className="bg-gray-900 rounded-xl border border-gray-800 px-4 py-3 flex items-center gap-3">
        <span className={dot(wsConnected)}></span>
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wide">WebSocket</div>
          <div className="text-sm font-medium">{wsConnected ? 'Connected' : 'Disconnected'}</div>
        </div>
      </div>

      <div className="bg-gray-900 rounded-xl border border-gray-800 px-4 py-3 flex items-center gap-3">
        <div className="flex flex-col gap-1.5 min-w-0">
          <div className="flex items-center gap-2">
            <span className={dot(mqttConnected)}></span>
            <div>
              <div className="text-xs text-gray-500 uppercase tracking-wide">MQTT</div>
              <div className="text-sm font-medium">{mqttConnected ? 'Connected' : 'Disconnected'}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 border-t border-gray-800 pt-1.5">
            <span className={dot(dbHealthy !== false)}></span>
            <div>
              <div className="text-xs text-gray-500 uppercase tracking-wide">SQLite</div>
              <div className="text-sm font-medium">{dbHealthy !== false ? 'OK' : 'Error'}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-gray-900 rounded-xl border border-gray-800 px-4 py-3">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Clients Online</div>
        <div className="text-2xl font-bold text-blue-400">{clientCount}</div>
      </div>

      <div className="bg-gray-900 rounded-xl border border-gray-800 px-4 py-3">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Access Points</div>
        <div className="space-y-1">
          {apEntries.length === 0 && (
            <div className="text-sm text-gray-600">No APs configured</div>
          )}
          {apEntries.map(function(entry) {
            const name = entry[0];
            const info = entry[1];
            return (
              <div key={name} className="flex items-center gap-2 text-sm">
                <span className={dot(info.online)}></span>
                <span className="truncate">{name}</span>
              </div>
            );
          })}
        </div>
      </div>

    </div>
  );
}
