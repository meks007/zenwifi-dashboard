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
  onMeshToggle,
  onApToggle,
  onVendorToggle,
  onOuiToggle,
}) {
  const isMesh       = client.isMeshNode;
  const isDiscovered = client.connectionType === 'discovered';
  const style        = isMobile
    ? {}
    : { width: colWidth + 'px', minWidth: colWidth + 'px', maxWidth: colWidth + 'px' };

  switch (col.id) {
    case 'mac':
      return (
        <td key="mac" style={style} className="px-3 py-3 font-mono text-xs text-blue-300 overflow-hidden text-ellipsis whitespace-nowrap">
          {client.mac}
        </td>
      );

    case 'vendor':
      return (
        <td key="vendor" style={style} className="px-3 py-3 text-xs text-left overflow-hidden">
          <VendorCell
            client={client}
            isMeshActive={meshOnly}
            activeVendors={activeVendors}
            activeOuis={activeOuis}
            onMeshClick={onMeshToggle}
            onVendorClick={onVendorToggle}
            onOuiClick={onOuiToggle}
          />
        </td>
      );

    case 'hostname':
      return (
        <td key="hostname" style={style} className="px-3 py-3 text-gray-300 overflow-hidden text-ellipsis whitespace-nowrap">
          {client.hostname || <span className="text-gray-600">n/a</span>}
        </td>
      );

    case 'ip':
      return (
        <td key="ip" style={style} className="px-3 py-3 font-mono text-xs text-gray-400 overflow-hidden text-ellipsis whitespace-nowrap">
          {client.ip || <span className="text-gray-600">n/a</span>}
        </td>
      );

    case 'apName': {
      const apActive = activeAps.has(client.apName);
      const apDot    = isMesh ? 'bg-indigo-400' : isDiscovered ? 'bg-amber-400' : 'bg-green-400';
      const apPill   = apActive
        ? 'bg-blue-900/50 border-blue-600/60 text-blue-300'
        : 'bg-gray-800/80 border-gray-700 text-gray-300 hover:bg-gray-700/70 hover:border-gray-500';
      return (
        <td key="apName" style={style} className="px-3 py-3 text-xs overflow-hidden">
          {client.apName ? (
            <button
              onClick={function(e) { e.stopPropagation(); onApToggle(client.apName); }}
              title={'Filter by AP: ' + client.apName}
              className={'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 border transition-colors ' + apPill}
            >
              <span className={'w-1.5 h-1.5 rounded-full flex-shrink-0 ' + apDot}></span>
              <span className="truncate max-w-[7rem]">{client.apName}</span>
            </button>
          ) : (
            <span className="text-gray-600">n/a</span>
          )}
        </td>
      );
    }

    case 'iface':
      return (
        <td key="iface" style={style} className="px-3 py-3 font-mono text-xs text-gray-500 overflow-hidden text-ellipsis whitespace-nowrap">
          {client.iface || 'n/a'}
        </td>
      );

    case 'rssi':
      return (
        <td key="rssi" style={style} className={'px-3 py-3 font-mono text-xs ' + rssiColor(client.rssi)}>
          {client.rssi != null ? client.rssi : <span className="text-gray-600">n/a</span>}
        </td>
      );

    case 'tx_bytes':
      return (
        <td key="tx_bytes" style={style} className="px-3 py-3 font-mono text-xs text-gray-400 overflow-hidden text-ellipsis whitespace-nowrap">
          {fmtBytes(client.tx_bytes) !== null ? fmtBytes(client.tx_bytes) : <span className="text-gray-600">n/a</span>}
        </td>
      );

    case 'rx_bytes':
      return (
        <td key="rx_bytes" style={style} className="px-3 py-3 font-mono text-xs text-gray-400 overflow-hidden text-ellipsis whitespace-nowrap">
          {fmtBytes(client.rx_bytes) !== null ? fmtBytes(client.rx_bytes) : <span className="text-gray-600">n/a</span>}
        </td>
      );

    case 'first_seen':
      return (
        <td key="first_seen" style={style} className="px-3 py-3 text-xs text-gray-500 overflow-hidden text-ellipsis whitespace-nowrap" title={fmtAbsolute(client.first_seen)}>
          {fmtRelative(client.first_seen) || <span className="text-gray-600">n/a</span>}
        </td>
      );

    case 'reachable': {
      // Only meaningful for discovered (wired) clients that have been pinged.
      if (!isDiscovered) {
        return <td key="reachable" style={style} className="px-3 py-3 text-gray-700 text-xs">-</td>;
      }
      var pingRel    = fmtRelative(client.last_ping_at);
      var pingResult = client.last_ping_result || null;
      // Derive success from "X/Y" string -- success means X === Y and X > 0
      var pingOk = false;
      if (pingResult) {
        var pingParts = pingResult.split('/');
        pingOk = pingParts.length === 2 && pingParts[0] === pingParts[1] && parseInt(pingParts[0], 10) > 0;
      }
      return (
        <td
          key="reachable"
          style={style}
          className="px-3 py-3 text-xs overflow-hidden text-ellipsis whitespace-nowrap"
          title={client.last_ping_at ? fmtAbsolute(client.last_ping_at) + ' - ' + (pingResult || '?') : 'Not yet pinged'}
        >
          {pingRel ? (
            <span className="inline-flex items-center gap-1.5">
              <span className={'w-1.5 h-1.5 rounded-full flex-shrink-0 ' + (pingOk ? 'bg-green-400' : 'bg-red-400')}></span>
              <span className="text-gray-400">{pingRel}</span>
              {pingResult && <span className={'font-mono ' + (pingOk ? 'text-green-400' : 'text-red-400')}>{pingResult}</span>}
            </span>
          ) : (
            <span className="text-gray-600">pending</span>
          )}
        </td>
      );
    }

    case 'actions':
      return (
        <td key="actions" style={style} className="px-3 py-3 text-right overflow-hidden">
          {!isMesh && !isDiscovered && (
            <button
              onClick={function(e) { e.stopPropagation(); onDisconnect(client.mac); }}
              disabled={!!disconnecting[client.mac]}
              className={
                'text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ' +
                (disconnecting[client.mac]
                  ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
                  : 'bg-red-600/20 text-red-400 border border-red-600/30 hover:bg-red-600/40 hover:text-red-300')
              }
            >
              {disconnecting[client.mac] ? 'Disconnecting...' : 'Disconnect'}
            </button>
          )}
        </td>
      );

    default:
      return <td key={col.id} style={style} className="px-3 py-3 text-gray-600">-</td>;
  }
}
