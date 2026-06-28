'use strict';

/**
 * HTTP route handlers.
 * Registered against the Express app by index.js at startup.
 */
function registerRoutes(app, deps) {
  var getCurrentClients = deps.getCurrentClients;
  var handleDisconnect  = deps.handleDisconnect;
  var getDbHealthy      = deps.getDbHealthy;

  app.post('/api/disconnect', async function(req, res) {
    var mac = (req.body.mac || '').toLowerCase().trim();
    if (!mac) return res.status(400).json({ success: false, error: 'mac required' });
    var result = await handleDisconnect(mac);
    res.status(result.success ? 200 : 400).json(result);
  });

  app.get('/api/status', function(_req, res) {
    res.json({ dbHealthy: getDbHealthy() });
  });
}

module.exports = { registerRoutes };
