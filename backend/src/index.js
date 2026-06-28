// Set of MACs for which an HA discovery payload has been published.
// publishDiscovery is only called when a MAC first appears (or re-appears
// after being unpublished). This avoids re-publishing on every poll cycle.
const haPublishedMacs = new Set();
