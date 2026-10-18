/**
 * Local Node.js Development Server for Knockout Sunday
 * Serves static files AND provides the /api/state endpoint backed by state-db.json
 * matching Netlify's serverless function (including 5-minute Battle Window & Store Combat).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '2026';
const DB_FILE = path.join(__dirname, 'state-db.json');

const INITIAL_STATE = {
  version: 1,
  updatedAt: new Date().toISOString(),
  districtName: 'PHOENIX DISTRICT',
  announcement: {
    text: '',
    active: false,
    updatedAt: null
  },
  battleWindow: {
    active: false,
    startedAt: null,
    endsAt: null,
    durationSeconds: 300
  },
  manualLines: {},
  salesLog: [],
  combatLog: [],
  customStores: [],
  settings: {
    koCost: 1,
    reviveCost: 1,
    koCanAttack: false,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/1hJuUd6UkzfWBeTywVM6Yi5g0BxJodsNLe0XHgt-9nOQ/edit?gid=1896995460'
  }
};

function readDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const data = JSON.parse(raw);
      return {
        ...INITIAL_STATE,
        ...data,
        battleWindow: { ...INITIAL_STATE.battleWindow, ...(data.battleWindow || {}) },
        settings: { ...INITIAL_STATE.settings, ...(data.settings || {}) }
      };
    }
  } catch (err) {
    console.warn('Error reading state-db.json:', err.message);
  }
  return JSON.parse(JSON.stringify(INITIAL_STATE));
}

function writeDb(newState) {
  const stamped = {
    ...INITIAL_STATE,
    ...newState,
    version: (Number(newState.version) || 1) + 1,
    updatedAt: new Date().toISOString()
  };
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(stamped, null, 2), 'utf8');
  } catch (err) {
    console.warn('Error writing state-db.json:', err.message);
  }
  return stamped;
}

function isBattleWindowCurrentlyOpen(state) {
  if (!state.battleWindow || !state.battleWindow.active || !state.battleWindow.endsAt) {
    return false;
  }
  return Date.now() < new Date(state.battleWindow.endsAt).getTime();
}

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
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/state' || pathname === '/.netlify/functions/state') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-pin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (req.method === 'GET') {
      const state = readDb();
      if (state.battleWindow?.active && !isBattleWindowCurrentlyOpen(state)) {
        state.battleWindow.active = false;
      }
      res.writeHead(200);
      return res.end(JSON.stringify(state));
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const providedPin = req.headers['x-admin-pin'] || parsed.pin || '';

          if (parsed.action === 'verify_pin') {
            const valid = String(providedPin).trim() === String(ADMIN_PIN).trim();
            res.writeHead(valid ? 200 : 401);
            return res.end(JSON.stringify({ ok: valid, error: valid ? null : 'Invalid Admin PIN' }));
          }

          if (parsed.action === 'store_combat') {
            const currentState = readDb();
            if (!isBattleWindowCurrentlyOpen(currentState)) {
              res.writeHead(403);
              return res.end(JSON.stringify({ error: 'The 5-Minute Battle Window is currently CLOSED!' }));
            }

            const evtType = parsed.type === 'REVIVE' ? 'REVIVE' : 'KO';
            const attackerId = String(parsed.attackerId || '').trim();
            const targetId = String(parsed.targetId || '').trim();
            const note = String(parsed.note || '').trim().slice(0, 120);
            const cost = evtType === 'REVIVE'
              ? Number(currentState.settings?.reviveCost || 1)
              : Number(currentState.settings?.koCost || 1);

            if (!attackerId || !targetId) {
              res.writeHead(400);
              return res.end(JSON.stringify({ error: 'Both attackerId and targetId are required.' }));
            }

            currentState.combatLog = Array.isArray(currentState.combatLog) ? currentState.combatLog : [];
            currentState.combatLog.push({
              id: 'evt_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
              timestamp: new Date().toISOString(),
              type: evtType,
              attackerId,
              targetId,
              cost,
              note,
              submittedByStore: true
            });

            const saved = writeDb(currentState);
            res.writeHead(200);
            return res.end(JSON.stringify(saved));
          }

          if (String(providedPin).trim() !== String(ADMIN_PIN).trim()) {
            res.writeHead(401);
            return res.end(JSON.stringify({ error: 'Unauthorized: Invalid Admin PIN' }));
          }

          const saved = writeDb(parsed.state || {});
          res.writeHead(200);
          return res.end(JSON.stringify(saved));
        } catch (err) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
  }

  let safePath = pathname === '/' ? '/index.html' : pathname;
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

server.listen(PORT, () => {
  console.log(`\n🥊 KNOCKOUT SUNDAY Server running at http://localhost:${PORT}`);
  console.log(`🔐 Default Admin PIN: ${ADMIN_PIN}\n`);
});
