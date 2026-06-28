'use strict';

/**
 * HTTP route handlers.
 * Registered against the Express app by index.js at startup.
 */
function registerRoutes(app, deps) {
  var getCurrentClients = deps.getCurrentClients;
  var handleDisconnect  = deps.handleDisconnect;
  var getDbHealthy      = deps.getDbHealthy;
  var handlePing        = deps.handlePing;
  var logger            = deps.logger;

  app.post('/api/disconnect', async function(req, res) {
    var mac = (req.body.mac || '').toLowerCase().trim();
    if (!mac) return res.status(400).json({ success: false, error: 'mac required' });
    var result = await handleDisconnect(mac);
    res.status(result.success ? 200 : 400).json(result);
  });

  app.post('/api/ping', async function(req, res) {
    var mac = (req.body.mac || '').toLowerCase().trim();
    if (!mac) return res.status(400).json({ success: false, error: 'mac required' });
    var result = await handlePing(mac);
    res.status(result.success ? 200 : 400).json(result);
  });

  app.get('/api/status', function(_req, res) {
    res.json({ dbHealthy: getDbHealthy() });
  });

  // ---------------------------------------------------------------------------
  // GET /api/logs
  //
  // Returns log entries from the file-backed logger.
  // Query parameters:
  //   lines=N   last N lines (0 or omitted = all)
  //   level=X   filter to entries at or above this level (debug|info|warn|error)
  //
  // Response: { entries: [...], total: N, truncated: bool }
  // ---------------------------------------------------------------------------
  var LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };

  app.get('/api/logs', function(req, res) {
    var lines     = parseInt(req.query.lines, 10) || 0;
    var levelStr  = (req.query.level || '').toLowerCase();
    var minLevel  = LEVEL_ORDER.hasOwnProperty(levelStr) ? LEVEL_ORDER[levelStr] : -1;

    var entries = logger.tail(lines);

    if (minLevel >= 0) {
      entries = entries.filter(function(e) {
        return (LEVEL_ORDER[e.level] || 0) >= minLevel;
      });
    }

    res.json({
      entries:   entries,
      total:     entries.length,
      truncated: lines > 0 && entries.length >= lines,
    });
  });
}

module.exports = { registerRoutes };
