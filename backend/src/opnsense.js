'use strict';

const { refreshDhcp, getDhcpInfo }                     = require('./opnsense-dhcp');
const { refreshNeighbors, getWiredClients, isNeighborDiscoveryEnabled } = require('./opnsense-neighbors');
const logger                                            = require('./logger');

// ---------------------------------------------------------------------------
// Refresh (leases + reservations + neighbors in one cycle)
// ---------------------------------------------------------------------------
async function refresh(cfg) {
  try {
    await refreshDhcp(cfg);
  } catch (err) {
    logger.error('[OPNsense] DHCP refresh failed: ' + err.message);
  }
  // Neighbor discovery runs in the same cycle but never blocks lease refresh
  await refreshNeighbors(cfg);
  logger.debug('[OPNsense] Refresh cycle complete');
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
function startPolling(cfg) {
  if (!cfg || !cfg.host || !cfg.api_key || !cfg.api_secret) {
    logger.warn('[OPNsense] Not configured - DHCP enrichment disabled. Set opnsense.host/api_key/api_secret in config.yaml.');
    return;
  }
  logger.info('[OPNsense] Starting DHCP polling against ' + cfg.host + ' every ' + (cfg.poll_interval || 60) + 's');
  if (isNeighborDiscoveryEnabled(cfg)) {
    logger.info('[OPNsense] Neighbor discovery enabled for interface(s): ' + (cfg.neighbor_discovery.interfaces || ['lan']).join(', '));
  } else {
    logger.info('[OPNsense] Neighbor discovery disabled.');
  }
  refresh(cfg);
  setInterval(function() { refresh(cfg); }, (cfg.poll_interval || 60) * 1000);
}

module.exports = { startPolling, getDhcpInfo, getWiredClients, isNeighborDiscoveryEnabled };
