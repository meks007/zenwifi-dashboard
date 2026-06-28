import { rssiColor, fmtBytes, fmtRelative, fmtAbsolute, macOui } from './clientTableUtils.js';
import { VendorCell } from './ClientTableControls.jsx';

// ---------------------------------------------------------------------------
// ClientTableCell
//
// Renders a single <td> for a given client row and column. All filter-toggle
// callbacks are passed explicitly so the data flow is visible.
// ---------------------------------------------------------------------------
export default function ClientTableCell({
  client,
  col,
  isMobile,
  colWidth,
  // filter state
  meshOnly,
  activeAps,
  activeVendors,
  activeOuis,
  // callbacks
  disconnecting,
  onDisconnect,
  pinging,
  onPing,
  onMeshToggle,
  onApToggle,
  onVendorToggle,
  onOuiToggle,
  // log navigation: called with a search string to jump to log view
  onLogSearch,
}) {
  const isMesh       = client.isMeshNode;
  const isDiscovered = client.connectionType === 'discovered';
  const style        = isMobile ? {} : { width: colWidth + 'px', minWidth: colWidth + 'px', maxWidth: colWidth + 'px' };

  switch (col.id) {
    case 'mac':
      return (
        <td className="px-3 py-2 font-mono text-xs whitespace-nowrap overflow-hidden text-ellipsis" style={style}>
          {client.mac ? (
            <button
              onClick={function() { if (onLogSearch) onLogSearch(client.mac); }}
              title={'Show logs for ' + client.mac}
              className="text-gray-300 hover:text-purple-300 transition-colors text-left"
            >
              {client.mac}
            </button>
          ) : (
            <span className="text-gray-600">n/a</span>
          )}
        </td>
      );

    case 'vendor':
      return (
        <VendorCell
          client={client}
          style={style}
          isMeshActive={meshOnly}
          activeVendors={activeVendors}
          activeOuis={activeOuis}
          onMeshClick={onMeshToggle}
          onVendorClick={onVendorToggle}
          onOuiClick={onOuiToggle}
        />
      );

    case 'hostname':
      return (
        <td className="px-3 py-2 text-sm text-gray-200 whitespace-nowrap overflow-hidden text-ellipsis" style={style}>
          {client.hostname || <span className="text-gray-600">n/a</span>}
        </td>
      );

    case 'ip':
      return (
        <td className="px-3 py-2 font-mono text-xs whitespace-nowrap overflow-hidden text-ellipsis" style={style}>
          {client.ip ? (
            <button
              onClick={function() { if (onLogSearch) onLogSearch(client.ip); }}
              title={'Show logs for ' + client.ip}
              className="text-gray-300 hover:text-green-300 transition-colors text-left"
            >
              {client.ip}
            </button>
          ) : (
            <span className="text-gray-600">n/a</span>
          )}
        </td>
      );

    case 'apName': {
      const apActive = activeAps.has(client.apName);
      const apDot    = isMesh ? 'bg-indigo-400' : isDiscovered ? 'bg-amber-400' : 'bg-green-400';
      const apPill   = apActive
        ? 'bg-blue-900/50 border-blue-600/60 text-blue-300'
        : 'bg-gray-800/80 border-gray-700 text-gray-300 hover:bg-gray-700/70 hover:border-gray-500';
      return (
        <td className="px-3 py-2 whitespace-nowrap overflow-hidden text-ellipsis" style={style}>
          {client.apName ? (
            <button
              onClick={function() { onApToggle(client.apName); }}
              className={'inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border transition-colors ' + apPill}
            >
              <span className={'w-1.5 h-1.5 rounded-full flex-shrink-0 ' + apDot} />
              {client.apName}
            </button>
          ) : (
            <span className="text-gray-600">n/a</span>
          )}
        </td>
      );
    }

    case 'iface':
      return (
        <td className="px-3 py-2 text-xs text-gray-400 whitespace-nowrap overflow-hidden text-ellipsis" style={style}>
          {client.iface || 'n/a'}
        </td>
      );

    case 'rssi':
      return (
        <td className={'px-3 py-2 text-xs font-mono whitespace-nowrap ' + rssiColor(client.rssi)} style={style}>
          {client.rssi != null ? client.rssi : <span className="text-gray-600">n/a</span>}
        </td>
      );

    case 'tx_bytes':
      return (
        <td className="px-3 py-2 text-xs font-mono text-gray-400 whitespace-nowrap" style={style}>
          {fmtBytes(client.tx_bytes) !== null ? fmtBytes(client.tx_bytes) : <span className="text-gray-600">n/a</span>}
        </td>
      );

    case 'rx_bytes':
      return (
        <td className="px-3 py-2 text-xs font-mono text-gray-400 whitespace-nowrap" style={style}>
          {fmtBytes(client.rx_bytes) !== null ? fmtBytes(client.rx_bytes) : <span className="text-gray-600">n/a</span>}
        </td>
      );

    case 'first_seen':
      return (
        <td className="px-3 py-2 text-xs text-gray-400 whitespace-nowrap" title={fmtAbsolute(client.first_seen)} style={style}>
          {fmtRelative(client.first_seen) || <span className="text-gray-600">n/a</span>}
        </td>
      );

    case 'reachable': {
      // Only meaningful for discovered (wired) clients that have been pinged.
      if (!isDiscovered) {
        return <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap" style={style}>-</td>;
      }
      var pingRel    = fmtRelative(client.last_ping_at);
      var pingResult = client.last_ping_result || null;
      var pingOk     = false;
      if (pingResult) {
        var pingParts = pingResult.split('/');
        pingOk = pingParts.length === 2 && pingParts[0] === pingParts[1] && parseInt(pingParts[0], 10) > 0;
      }
      return (
        <td className="px-3 py-2 text-xs whitespace-nowrap" style={style}>
          {pingRel ? (
            <span className={pingOk ? 'text-green-400' : 'text-red-400'}>
              {pingRel}
              {pingResult && <span className="ml-1 text-gray-500">({pingResult})</span>}
            </span>
          ) : (
            <span className="text-gray-500 italic">pending</span>
          )}
        </td>
      );
    }

    case 'actions':
      return (
        <td className="px-3 py-2 whitespace-nowrap" style={style}>
          <div className="flex items-center gap-2">
            {!isMesh && !isDiscovered && (
              <button
                onClick={function() { onDisconnect(client.mac); }}
                disabled={!!disconnecting[client.mac]}
                className="text-xs px-2 py-1 rounded bg-red-900/40 hover:bg-red-800/60 text-red-300 border border-red-800/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {disconnecting[client.mac] ? 'Disconnecting...' : 'Disconnect'}
              </button>
            )}
            {isDiscovered && (
              <button
                onClick={function() { onPing(client.mac); }}
                disabled={!!pinging[client.mac]}
                className="text-xs px-2 py-1 rounded bg-amber-900/40 hover:bg-amber-800/60 text-amber-300 border border-amber-800/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {pinging[client.mac] ? 'Pinging...' : 'Ping'}
              </button>
            )}
          </div>
        </td>
      );

    default:
      return <td className="px-3 py-2 text-xs text-gray-600" style={style}>-</td>;
  }
}
