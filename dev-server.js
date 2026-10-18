/**
 * Knockout Blitz — Local & Standalone Node.js Server
 * Uses the unified API controller (lib/api-handler.js) and runs a background
 * boundary scheduler so cutoffs, rounds, Power Phase checks, eliminations,
 * daily closing, and weekly rollovers execute reliably even when no browser is open.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleApiRequest } = require('./lib/api-handler');
const { transactState } = require('./lib/storage');
const { processScheduledBoundaries } = require('./lib/engine');
const { getConfiguredAdminPin } = require('./lib/auth');

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/state' || pathname === '/.netlify/functions/state') {
    let rawBody = '';
    req.on('data', chunk => {
      rawBody += chunk;
    });
    req.on('end', async () => {
      let parsedBody = {};
      if (rawBody) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid JSON request body' }));
        }
      }

      try {
        const apiRes = await handleApiRequest({
          method: req.method,
          headers: req.headers,
          body: parsedBody
        });
        res.writeHead(apiRes.statusCode, apiRes.headers);
        res.end(apiRes.bodyObj !== null && apiRes.bodyObj !== undefined ? JSON.stringify(apiRes.bodyObj) : '');
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
      }
    });
    return;
  }

  // Static files
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(__dirname, path.normalize(safePath).replace(/^(\.\.[\/\\])+/, ''));

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

// Background scheduler: executes scheduled cutoffs, round starts/closes, Power phase checks,
// automatic eliminations, daily closing, and Sunday 7:00 PM ET weekly rollover without an open browser.
const schedulerTimer = setInterval(() => {
  transactState((state, nowMs) => {
    processScheduledBoundaries(state, nowMs);
  }).catch(() => {});
}, 5000);
schedulerTimer.unref();

if (require.main === module) {
  server.listen(PORT, () => {
    const adminConfigured = Boolean(getConfiguredAdminPin());
    console.log(`\n🥊 KNOCKOUT BLITZ Server running at http://localhost:${PORT}`);
    console.log(
      adminConfigured
        ? '🔐 Admin PIN is provisioned via environment variable.'
        : '⚠️  ADMIN_PIN environment variable is NOT set. Admin mutations are locked until ADMIN_PIN is provided.'
    );
  });
}

module.exports = { server };
