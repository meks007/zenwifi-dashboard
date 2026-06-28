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

  // GET /api/logs?n=100   -- return last n lines (default 100, 0 = all)
  // GET /api/logs?all=1   -- return all lines across all rotated files
  app.get('/api/logs', function(req, res) {
    if (!logger) return res.status(503).json({ error: 'logger not available' });
    var n = (req.query.all === '1' || req.query.all === 'true') ? 0 : parseInt(req.query.n, 10) || 100;
    res.json({ entries: logger.tail(n) });
  });

  // GET /api/debug          -- return current debug mode state
  // POST /api/debug         -- toggle debug mode: { "enabled": true|false }
  app.get('/api/debug', function(_req, res) {
    res.json({ debug: logger ? logger.isDebug() : false });
  });

  app.post('/api/debug', function(req, res) {
    if (!logger) return res.status(503).json({ error: 'logger not available' });
    var enabled = !!req.body.enabled;
    logger.setDebug(enabled);
    logger.info('[Debug] Debug logging ' + (enabled ? 'enabled' : 'disabled') + ' via API');
    if (deps.broadcast) deps.broadcast({ type: 'debug_mode', enabled: enabled });
    res.json({ debug: enabled });
  });
}

module.exports = { registerRoutes };
