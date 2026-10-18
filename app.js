/**
 * 🥊 KNOCKOUT SUNDAY! 🔥 — District Battle Arena (Public Viewer + Server Admin Edition)
 * Syncs with:
 *   1. Shared Server Endpoint (/api/state -> Netlify Functions + Blobs or local dev-server.js)
 *   2. Google Sheet (1hJuUd6UkzfWBeTywVM6Yi5g0BxJodsNLe0XHgt-9nOQ, gid=1896995460)
 */

const DEFAULT_SHEET_ID = '1hJuUd6UkzfWBeTywVM6Yi5g0BxJodsNLe0XHgt-9nOQ';
const DEFAULT_GID = '1896995460';
const LOCAL_CACHE_KEY = 'knockout_sunday_server_cache_v2';
const ADMIN_PIN_STORAGE_KEY = 'knockout_sunday_admin_pin';

// Initial snapshot from the Google Sheet so it loads instantaneously
const INITIAL_SHEET_SNAPSHOT = [
  { id: '843D', name: '843D - El Cartel', emoji: '🎩', nrGoal: 1281, netRev: 95, accGoal: 349, acc: 50, postGoal: 7, totalPP: 1, vl: 1, bts: 0, hsi: 0, visa: 0, preOrders: 1 },
  { id: '693D', name: '693D - Spartans', emoji: '⚔️', nrGoal: 1316, netRev: 0, accGoal: 371, acc: 0, postGoal: 9, totalPP: 0, vl: 0, bts: 0, hsi: 0, visa: 0, preOrders: 0 },
  { id: '561D', name: '561D - Top Guns', emoji: '✈️', nrGoal: 1442, netRev: 456, accGoal: 300, acc: 0, postGoal: 8, totalPP: 3, vl: 3, bts: 0, hsi: 0, visa: 0, preOrders: 0 },
  { id: '5383', name: '5383 - Pink Panthers', emoji: '🐾', nrGoal: 1474, netRev: 1305, accGoal: 452, acc: 120, postGoal: 8, totalPP: 6, vl: 5, bts: 1, hsi: 0, visa: 0, preOrders: 0 },
  { id: '769D', name: '769D - Pink Mafia', emoji: '🕶️', nrGoal: 1688, netRev: 0, accGoal: 431, acc: 0, postGoal: 11, totalPP: 0, vl: 0, bts: 0, hsi: 0, visa: 0, preOrders: 0 },
  { id: '5733', name: '5733 - Undefeated', emoji: '👑', nrGoal: 972, netRev: 779, accGoal: 263, acc: 115, postGoal: 6, totalPP: 7, vl: 2, bts: 4, hsi: 1, visa: 0, preOrders: 0 },
  { id: '582D', name: '582D - Magenta Warriors', emoji: '🛡️', nrGoal: 956, netRev: 0, accGoal: 304, acc: 0, postGoal: 5, totalPP: 0, vl: 0, bts: 0, hsi: 0, visa: 0, preOrders: 0 },
  { id: '892E', name: '892E - Avengers', emoji: '⚡', nrGoal: 710, netRev: 0, accGoal: 169, acc: 0, postGoal: 5, totalPP: 0, vl: 0, bts: 0, hsi: 0, visa: 0, preOrders: 0 },
  { id: '697D', name: '697D - Wolfpack', emoji: '🐺', nrGoal: 1369, netRev: 184, accGoal: 487, acc: 20, postGoal: 10, totalPP: 2, vl: 2, bts: 0, hsi: 0, visa: 0, preOrders: 0 }
];

const STORE_EMOJIS = {
  '843D': '🎩',
  '693D': '⚔️',
  '561D': '✈️',
  '5383': '🐾',
  '769D': '🕶️',
  '5733': '👑',
  '582D': '🛡️',
  '892E': '⚡',
  '697D': '🐺'
};

const LINE_LABELS = {
  vl: { name: 'VL Activation', ptsUnit: '1 pt', emoji: '📱' },
  beyondVl: { name: 'Beyond VL Activation', ptsUnit: '2 pts', emoji: '💥' },
  watches: { name: 'Watch (BTS)', ptsUnit: '1 pt', emoji: '⌚' },
  tablets: { name: 'Tablet (BTS)', ptsUnit: '1 pt', emoji: '📟' },
  hsi: { name: 'HINT (HSI)', ptsUnit: '2 pts', emoji: '🏠' },
  acc: { name: 'Accessories $', ptsUnit: '$100 = 1 pt', emoji: '🎧' },
  bonusPts: { name: 'Bonus Points', ptsUnit: 'Direct pts', emoji: '⭐' }
};

let state = {
  version: 1,
  districtName: 'PHOENIX DISTRICT',
  sheetStores: JSON.parse(JSON.stringify(INITIAL_SHEET_SNAPSHOT)),
  customStores: [],
  announcement: { text: '', active: false, updatedAt: null },
  // { [storeId]: { vl: 0, beyondVl: 0, watches: 0, tablets: 0, hsi: 0, acc: 0, bonusPts: 0 } }
  manualLines: {},
  // [ { id, timestamp, storeId, category, qty, note } ]
  salesLog: [],
  // [ { id, timestamp, type: 'KO' | 'REVIVE', attackerId, targetId, cost, note } ]
  combatLog: [],
  settings: {
    koCost: 1,
    reviveCost: 1,
    koCanAttack: false,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${DEFAULT_SHEET_ID}/edit?gid=${DEFAULT_GID}`,
    soundEnabled: true
  },
  auth: {
    isAdmin: false,
    pin: ''
  },
  ui: {
    filter: 'all',
    sortBy: 'available_desc',
    commandMode: 'lines', // 'lines' | 'ko' | 'revive' | 'announce'
    lastCombatEventId: null
  }
};

// Web Audio API Sound Effects
const SoundFX = {
  ctx: null,
  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
  },
  playKO() {
    if (!state.settings.soundEnabled) return;
    try {
      this.init();
      const now = this.ctx.currentTime;
      const osc1 = this.ctx.createOscillator();
      const gain1 = this.ctx.createGain();
      osc1.type = 'sawtooth';
      osc1.frequency.setValueAtTime(150, now);
      osc1.frequency.exponentialRampToValueAtTime(32, now + 0.25);
      gain1.gain.setValueAtTime(0.6, now);
      gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
      osc1.connect(gain1);
      gain1.connect(this.ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.3);

      [880, 1320, 1760].forEach((freq, idx) => {
        const bell = this.ctx.createOscillator();
        const bGain = this.ctx.createGain();
        bell.type = 'sine';
        bell.frequency.setValueAtTime(freq, now + 0.08);
        bGain.gain.setValueAtTime(0.25 / (idx + 1), now + 0.08);
        bGain.gain.exponentialRampToValueAtTime(0.001, now + 1.1);
        bell.connect(bGain);
        bGain.connect(this.ctx.destination);
        bell.start(now + 0.08);
        bell.stop(now + 1.15);
      });
    } catch (e) {}
  },
  playRevive() {
    if (!state.settings.soundEnabled) return;
    try {
      this.init();
      const now = this.ctx.currentTime;
      [330, 440, 554.37, 659.25, 880].forEach((freq, idx) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + idx * 0.07);
        gain.gain.setValueAtTime(0.25, now + idx * 0.07);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.07 + 0.35);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now + idx * 0.07);
        osc.stop(now + idx * 0.07 + 0.36);
      });
    } catch (e) {}
  },
  playCoin() {
    if (!state.settings.soundEnabled) return;
    try {
      this.init();
      const now = this.ctx.currentTime;
      [987.77, 1318.51].forEach((freq, idx) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.08);
        gain.gain.setValueAtTime(0.2, now + idx * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.25);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now + idx * 0.08);
        osc.stop(now + idx * 0.08 + 0.26);
      });
    } catch (e) {}
  }
};

// Local cache fallback
function loadLocalCache() {
  try {
    const savedPin = sessionStorage.getItem(ADMIN_PIN_STORAGE_KEY);
    if (savedPin) {
      state.auth.pin = savedPin;
      state.auth.isAdmin = true;
    }
    const raw = localStorage.getItem(LOCAL_CACHE_KEY);
    if (!raw) return;
    const cached = JSON.parse(raw);
    applySharedStateObject(cached, false);
  } catch (e) {}
}

function saveLocalCache() {
  try {
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(getSerializableSharedState()));
  } catch (e) {}
}

function getSerializableSharedState() {
  return {
    version: state.version,
    districtName: state.districtName,
    announcement: state.announcement,
    manualLines: state.manualLines,
    salesLog: state.salesLog,
    combatLog: state.combatLog,
    customStores: state.customStores,
    settings: {
      koCost: state.settings.koCost,
      reviveCost: state.settings.reviveCost,
      koCanAttack: state.settings.koCanAttack,
      sheetUrl: state.settings.sheetUrl
    }
  };
}

function applySharedStateObject(serverData, triggerNewEventFX = true) {
  if (!serverData || typeof serverData !== 'object') return;

  const prevLastKoId = state.combatLog.length > 0 ? state.combatLog[state.combatLog.length - 1].id : null;

  if (serverData.districtName) state.districtName = serverData.districtName;
  if (serverData.announcement) state.announcement = serverData.announcement;
  if (serverData.manualLines) state.manualLines = serverData.manualLines;
  if (Array.isArray(serverData.salesLog)) state.salesLog = serverData.salesLog;
  if (Array.isArray(serverData.combatLog)) state.combatLog = serverData.combatLog;
  if (Array.isArray(serverData.customStores)) state.customStores = serverData.customStores;
  if (serverData.settings) {
    state.settings = { ...state.settings, ...serverData.settings };
  }
  if (serverData.version) state.version = serverData.version;

  // If a brand new KO or Revive arrived from the server while a viewer is watching, play the FX banner!
  if (triggerNewEventFX && state.combatLog.length > 0) {
    const latestEvt = state.combatLog[state.combatLog.length - 1];
    if (latestEvt.id !== prevLastKoId && state.ui.lastCombatEventId !== null) {
      const computed = getComputedStores();
      const actor = computed.find(s => s.id === latestEvt.attackerId) || { name: latestEvt.attackerId };
      const target = computed.find(s => s.id === latestEvt.targetId) || { name: latestEvt.targetId };
      if (latestEvt.type === 'KO') SoundFX.playKO();
      else SoundFX.playRevive();
      triggerBannerFX(latestEvt.type, actor, target, latestEvt.note);
    }
  }
  if (state.combatLog.length > 0) {
    state.ui.lastCombatEventId = state.combatLog[state.combatLog.length - 1].id;
  }
}

// Fetch shared state from Netlify /api/state
async function fetchServerState(triggerFX = true) {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      applySharedStateObject(data, triggerFX);
      saveLocalCache();
      renderAll();
      return true;
    }
  } catch (err) {
    // Offline or opened via file://
  }
  return false;
}

// Push updated state from Admin to Netlify /api/state
async function pushServerState() {
  saveLocalCache();
  renderAll();
  if (!state.auth.isAdmin || !state.auth.pin) return;

  const syncStatusText = document.getElementById('sync-status-text');
  const syncDot = document.getElementById('sync-dot');
  try {
    syncDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse';
    syncStatusText.textContent = 'Saving to Server...';

    const res = await fetch('/api/state', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-pin': state.auth.pin
      },
      body: JSON.stringify({
        pin: state.auth.pin,
        state: getSerializableSharedState()
      })
    });

    if (res.status === 401) {
      alert('Your Admin PIN was rejected by the server. Please log in again.');
      lockAdminMode();
      return;
    }

    if (res.ok) {
      const saved = await res.json();
      state.version = saved.version || state.version;
      const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      syncDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400';
      syncStatusText.textContent = 'Saved Live to Server';
      document.getElementById('sync-time-text').textContent = `Updated: ${nowStr}`;
    }
  } catch (err) {
    syncDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400';
    syncStatusText.textContent = 'Saved Locally';
  }
}

// Combine sheet stores + custom stores + manualLines + combatLog
function getComputedStores() {
  const allBaseStores = [...state.sheetStores];
  state.customStores.forEach(cs => {
    if (!allBaseStores.some(s => s.id === cs.id)) {
      allBaseStores.push({
        id: cs.id,
        name: cs.name,
        emoji: cs.emoji || '🥊',
        nrGoal: cs.nrGoal || 1000,
        netRev: cs.netRev || 0,
        accGoal: cs.accGoal || 300,
        acc: cs.acc || 0,
        postGoal: cs.postGoal || 6,
        totalPP: cs.totalPP || 0,
        vl: cs.vl || 0,
        bts: cs.bts || 0,
        hsi: cs.hsi || 0,
        visa: 0,
        preOrders: 0,
        isCustom: true
      });
    }
  });

  const statusMap = {};
  allBaseStores.forEach(s => {
    statusMap[s.id] = {
      isEliminated: false,
      eliminatedBy: null,
      eliminatedAt: null,
      eliminatedNote: null,
      kosDealt: 0,
      timesEliminated: 0,
      timesRevived: 0,
      pointsSpent: 0
    };
  });

  state.combatLog.forEach(evt => {
    if (evt.type === 'KO') {
      if (statusMap[evt.attackerId]) {
        statusMap[evt.attackerId].kosDealt += 1;
        statusMap[evt.attackerId].pointsSpent += Number(evt.cost || 1);
      }
      if (statusMap[evt.targetId]) {
        statusMap[evt.targetId].isEliminated = true;
        statusMap[evt.targetId].eliminatedBy = evt.attackerId;
        statusMap[evt.targetId].eliminatedAt = evt.timestamp;
        statusMap[evt.targetId].eliminatedNote = evt.note || '';
        statusMap[evt.targetId].timesEliminated += 1;
      }
    } else if (evt.type === 'REVIVE') {
      const payerId = evt.attackerId || evt.targetId;
      if (statusMap[payerId]) {
        statusMap[payerId].pointsSpent += Number(evt.cost || 1);
      }
      if (statusMap[evt.targetId]) {
        statusMap[evt.targetId].isEliminated = false;
        statusMap[evt.targetId].eliminatedBy = null;
        statusMap[evt.targetId].eliminatedNote = null;
        statusMap[evt.targetId].timesRevived += 1;
      }
    }
  });

  return allBaseStores.map((store, index) => {
    const m = state.manualLines[store.id] || {};
    const sheetVl = Number(store.vl || 0);
    const manualVl = Number(m.vl || 0);
    const beyondVl = Math.max(0, Number(m.beyondVl || 0));

    const sheetBts = Number(store.bts || 0);
    const manualWatches = Number(m.watches || 0);
    const manualTablets = Number(m.tablets || 0);
    const manualBts = manualWatches + manualTablets;

    const sheetHsi = Number(store.hsi || 0);
    const manualHsi = Number(m.hsi || 0);

    const sheetAcc = Number(store.acc || 0);
    const manualAcc = Number(m.acc || 0);

    const bonusPts = Number(m.bonusPts || 0);

    // Combined totals (Sheet + Admin manual entries)
    const vl = Math.max(0, sheetVl + manualVl);
    const bts = Math.max(0, sheetBts + manualBts);
    const hsi = Math.max(0, sheetHsi + manualHsi);
    const acc = Math.max(0, sheetAcc + manualAcc);

    // Points Calculation
    const vlPts = vl * 1;
    const beyondVlPts = beyondVl * 2;
    const btsPts = bts * 1;
    const hsiPts = hsi * 2;
    const accPts = Math.floor(acc / 100);
    const accNextHundred = 100 - (acc % 100);

    const earnedPoints = Math.max(0, vlPts + beyondVlPts + btsPts + hsiPts + accPts + bonusPts);
    const cStatus = statusMap[store.id] || {
      isEliminated: false,
      eliminatedBy: null,
      kosDealt: 0,
      timesEliminated: 0,
      timesRevived: 0,
      pointsSpent: 0
    };
    const availablePoints = Math.max(0, earnedPoints - cStatus.pointsSpent);

    return {
      ...store,
      sheetOrder: index,
      emoji: STORE_EMOJIS[store.id] || store.emoji || '🥊',
      sheetVl,
      manualVl,
      vl,
      beyondVl,
      sheetBts,
      manualWatches,
      manualTablets,
      manualBts,
      bts,
      sheetHsi,
      manualHsi,
      hsi,
      sheetAcc,
      manualAcc,
      acc,
      bonusPts,
      vlPts,
      beyondVlPts,
      btsPts,
      hsiPts,
      accPts,
      accNextHundred,
      earnedPoints,
      pointsSpent: cStatus.pointsSpent,
      availablePoints,
      isEliminated: cStatus.isEliminated,
      eliminatedBy: cStatus.eliminatedBy,
      eliminatedAt: cStatus.eliminatedAt,
      eliminatedNote: cStatus.eliminatedNote,
      kosDealt: cStatus.kosDealt,
      timesEliminated: cStatus.timesEliminated,
      timesRevived: cStatus.timesRevived
    };
  });
}

// Parse CSV line
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCurrencyOrNumber(val) {
  if (!val || val.includes('#DIV/0!') || val.includes('#VALUE!')) return 0;
  const cleaned = String(val).replace(/[$,%\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function extractSheetIds(urlOrId) {
  let sheetId = DEFAULT_SHEET_ID;
  let gid = DEFAULT_GID;
  const matchId = String(urlOrId).match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (matchId) sheetId = matchId[1];
  const matchGid = String(urlOrId).match(/gid=([0-9]+)/);
  if (matchGid) gid = matchGid[1];
  return { sheetId, gid };
}

// Full sync: Pull server state + Google Sheet
async function syncAll() {
  const syncDot = document.getElementById('sync-dot');
  const syncStatusText = document.getElementById('sync-status-text');
  const syncTimeText = document.getElementById('sync-time-text');
  const syncIcon = document.getElementById('sync-icon');

  syncIcon.classList.add('animate-spin');
  syncDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse';
  syncStatusText.textContent = 'Syncing Live...';

  await fetchServerState(true);

  const { sheetId, gid } = extractSheetIds(state.settings.sheetUrl);
  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;

  try {
    let csvText = null;
    try {
      const response = await fetch(csvUrl, { cache: 'no-store' });
      if (response.ok) csvText = await response.text();
    } catch (directErr) {
      csvText = await fetchViaGvizJsonp(sheetId, gid);
    }

    if (csvText) {
      const parsedStores = parseSheetCSV(csvText);
      if (parsedStores.length > 0) {
        state.sheetStores = parsedStores;
      }
    }

    const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    syncDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400';
    syncStatusText.textContent = 'Live Sync Active';
    syncTimeText.textContent = `Synced: ${nowStr}`;
  } catch (err) {
    syncDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400';
    syncStatusText.textContent = 'Live Arena Ready';
  } finally {
    syncIcon.classList.remove('animate-spin');
    renderAll();
  }
}

function fetchViaGvizJsonp(sheetId, gid) {
  return new Promise((resolve, reject) => {
    const callbackName = 'gvizCallback_' + Math.floor(Math.random() * 1000000);
    const script = document.createElement('script');
    let timer = setTimeout(() => {
      cleanup();
      reject(new Error('JSONP timeout'));
    }, 6000);

    function cleanup() {
      clearTimeout(timer);
      delete window[callbackName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[callbackName] = function (data) {
      cleanup();
      try {
        if (!data || !data.table || !data.table.rows) return reject(new Error('Invalid gviz'));
        const lines = data.table.rows.map(row => {
          return (row.c || []).map(cell => {
            if (!cell) return '';
            const val = cell.f !== undefined && cell.f !== null ? cell.f : (cell.v !== null && cell.v !== undefined ? cell.v : '');
            return `"${String(val).replace(/"/g, '""')}"`;
          }).join(',');
        });
        resolve(lines.join('\n'));
      } catch (e) {
        reject(e);
      }
    };

    script.src = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?gid=${gid}&tqx=out:json;responseHandler:${callbackName}`;
    script.onerror = () => {
      cleanup();
      reject(new Error('JSONP script error'));
    };
    document.body.appendChild(script);
  });
}

function parseSheetCSV(csvText) {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
  const parsedStores = [];

  for (const line of lines) {
    const cols = parseCSVLine(line);
    const colB = (cols[1] || '').trim();
    if (!colB) continue;

    const storeMatch = colB.match(/^([0-9A-Z]{3,5})\s*-\s*(.+)$/i);
    if (storeMatch) {
      const id = storeMatch[1].toUpperCase();
      const fullName = `${id} - ${storeMatch[2].trim()}`;
      parsedStores.push({
        id,
        name: fullName,
        emoji: STORE_EMOJIS[id] || '🥊',
        nrGoal: parseCurrencyOrNumber(cols[4]),
        netRev: parseCurrencyOrNumber(cols[5]),
        accGoal: parseCurrencyOrNumber(cols[7]),
        acc: parseCurrencyOrNumber(cols[8]),
        postGoal: parseCurrencyOrNumber(cols[10]),
        totalPP: parseCurrencyOrNumber(cols[11]),
        vl: parseCurrencyOrNumber(cols[13]),
        bts: parseCurrencyOrNumber(cols[14]),
        hsi: parseCurrencyOrNumber(cols[15]),
        visa: parseCurrencyOrNumber(cols[16]),
        preOrders: parseCurrencyOrNumber(cols[17])
      });
    }
  }
  return parsedStores;
}

// ADMIN: Adjust manual line or log a manual sale
function ensureManualStoreObj(storeId) {
  if (!state.manualLines[storeId]) {
    state.manualLines[storeId] = { vl: 0, beyondVl: 0, watches: 0, tablets: 0, hsi: 0, acc: 0, bonusPts: 0 };
  }
}

window.adjustStoreManual = function (storeId, field, delta) {
  if (!state.auth.isAdmin) return;
  ensureManualStoreObj(storeId);
  const current = Number(state.manualLines[storeId][field] || 0);
  state.manualLines[storeId][field] = current + delta;
  SoundFX.playCoin();
  pushServerState();
};

// ADMIN: 1-Click Quick Log Sale from Admin Command Center
window.quickLogSale = function (category, qty, customNote = '') {
  if (!state.auth.isAdmin) return;
  const storeSelect = document.getElementById('select-line-store');
  const storeId = storeSelect ? storeSelect.value : '';
  if (!storeId) {
    alert('Select a store first!');
    return;
  }

  ensureManualStoreObj(storeId);
  const numQty = Number(qty || 0);
  if (numQty === 0) return;

  state.manualLines[storeId][category] = Number(state.manualLines[storeId][category] || 0) + numQty;

  const computed = getComputedStores();
  const store = computed.find(s => s.id === storeId) || { name: storeId };
  const meta = LINE_LABELS[category] || { name: category, emoji: '⚡' };

  state.salesLog.push({
    id: 'sale_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    timestamp: new Date().toISOString(),
    storeId,
    category,
    qty: numQty,
    note: customNote
  });

  SoundFX.playCoin();
  triggerBannerFX('LINE', store, null, `${numQty > 0 ? '+' : ''}${category === 'acc' ? '$' + numQty : numQty} ${meta.name}${customNote ? ' — ' + customNote : ''}`);
  pushServerState();
};

// Undo / Delete a manual sale entry from the feed
window.deleteSaleEvent = function (saleId) {
  if (!state.auth.isAdmin) return;
  const sale = state.salesLog.find(s => s.id === saleId);
  if (sale && state.manualLines[sale.storeId]) {
    state.manualLines[sale.storeId][sale.category] =
      Number(state.manualLines[sale.storeId][sale.category] || 0) - Number(sale.qty || 0);
  }
  state.salesLog = state.salesLog.filter(s => s.id !== saleId);
  pushServerState();
};

// Pre-fill Admin Command Center from a Store Card button
window.quickSelectAction = function (storeId, actionType) {
  if (!state.auth.isAdmin) {
    openAdminLoginModal();
    return;
  }
  const computed = getComputedStores();
  const store = computed.find(s => s.id === storeId);
  if (!store) return;

  if (actionType === 'add_line') {
    setCommandMode('lines');
    const sel = document.getElementById('select-line-store');
    if (sel) sel.value = storeId;
    sel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (actionType === 'attack') {
    setCommandMode('ko');
    const attackerSelect = document.getElementById('select-attacker');
    if (attackerSelect) attackerSelect.value = storeId;
    document.getElementById('select-target')?.focus();
  } else if (actionType === 'target') {
    setCommandMode('ko');
    const targetSelect = document.getElementById('select-target');
    if (targetSelect) targetSelect.value = storeId;
    document.getElementById('select-attacker')?.focus();
  } else if (actionType === 'revive') {
    setCommandMode('revive');
    const reviveTargetSelect = document.getElementById('select-revive-target');
    const revivePayerSelect = document.getElementById('select-revive-payer');
    if (reviveTargetSelect) reviveTargetSelect.value = storeId;
    if (revivePayerSelect && store.availablePoints >= state.settings.reviveCost) {
      revivePayerSelect.value = storeId;
    }
  }
};

// Execute Knockout (Admin)
function executeKnockout() {
  if (!state.auth.isAdmin) return;
  const attackerId = document.getElementById('select-attacker').value;
  const targetId = document.getElementById('select-target').value;
  const noteInput = document.getElementById('input-ko-note');
  const note = (noteInput.value || '').trim();

  if (!attackerId || !targetId) {
    alert('Select both an attacking store and a target store!');
    return;
  }
  if (attackerId === targetId) {
    alert('A store cannot eliminate itself! Pick a rival store in the district!');
    return;
  }

  const computed = getComputedStores();
  const attacker = computed.find(s => s.id === attackerId);
  const target = computed.find(s => s.id === targetId);
  const cost = Number(state.settings.koCost || 1);

  if (!attacker || !target) return;
  if (!state.settings.koCanAttack && attacker.isEliminated) {
    alert(`${attacker.name} is currently KNOCKED OUT! They must REVIVE first before eliminating another store.`);
    return;
  }
  if (attacker.availablePoints < cost) {
    alert(`${attacker.name} needs at least ${cost} available point(s) to deliver a Knockout!`);
    return;
  }
  if (target.isEliminated) {
    alert(`${target.name} is already knocked out!`);
    return;
  }

  const newEvt = {
    id: 'evt_' + Date.now(),
    timestamp: new Date().toISOString(),
    type: 'KO',
    attackerId,
    targetId,
    cost,
    note
  };
  state.combatLog.push(newEvt);
  state.ui.lastCombatEventId = newEvt.id;

  noteInput.value = '';
  SoundFX.playKO();
  triggerBannerFX('KO', attacker, target, note);
  pushServerState();
}

// Execute Revive (Admin)
function executeRevive() {
  if (!state.auth.isAdmin) return;
  const targetId = document.getElementById('select-revive-target').value;
  const payerId = document.getElementById('select-revive-payer').value;
  const noteInput = document.getElementById('input-revive-note');
  const note = (noteInput.value || '').trim();

  if (!targetId || !payerId) {
    alert('Select a knocked-out store to revive and a store with available points!');
    return;
  }

  const computed = getComputedStores();
  const target = computed.find(s => s.id === targetId);
  const payer = computed.find(s => s.id === payerId);
  const cost = Number(state.settings.reviveCost || 1);

  if (!target || !payer) return;
  if (!target.isEliminated) {
    alert(`${target.name} is already standing in the arena!`);
    return;
  }
  if (payer.availablePoints < cost) {
    alert(`${payer.name} needs at least ${cost} available point(s) to trigger a Revive!`);
    return;
  }

  const newEvt = {
    id: 'evt_' + Date.now(),
    timestamp: new Date().toISOString(),
    type: 'REVIVE',
    attackerId: payerId,
    targetId,
    cost,
    note
  };
  state.combatLog.push(newEvt);
  state.ui.lastCombatEventId = newEvt.id;

  noteInput.value = '';
  SoundFX.playRevive();
  triggerBannerFX('REVIVE', payer, target, note);
  pushServerState();
}

function undoLastAction() {
  if (!state.auth.isAdmin || state.combatLog.length === 0) return;
  state.combatLog.pop();
  pushServerState();
}

window.deleteCombatEvent = function (eventId) {
  if (!state.auth.isAdmin) return;
  state.combatLog = state.combatLog.filter(e => e.id !== eventId);
  pushServerState();
};

// Trigger dramatic overlay banner
function triggerBannerFX(type, actor, target, note) {
  const overlay = document.getElementById('fx-overlay');
  const banner = document.getElementById('fx-banner');
  const emoji = document.getElementById('fx-emoji');
  const title = document.getElementById('fx-title');
  const subtitle = document.getElementById('fx-subtitle');

  document.body.classList.remove('shake-screen');
  void document.body.offsetWidth;
  document.body.classList.add('shake-screen');

  if (type === 'KO') {
    banner.className = 'transform scale-100 transition-transform duration-300 text-center px-10 py-8 rounded-3xl border-2 border-red-500 bg-gradient-to-b from-red-950/95 via-zinc-950/95 to-black/95 shadow-2xl shadow-red-600/50 backdrop-blur-xl';
    emoji.textContent = '🥊💥';
    title.className = 'font-display text-6xl md:text-7xl tracking-wider uppercase text-red-400 drop-shadow-lg';
    title.textContent = 'KNOCKOUT!';
    subtitle.innerHTML = `<span class="text-white font-extrabold">${escapeHtml(actor.name)}</span> ELIMINATED <span class="text-red-400 font-extrabold">${escapeHtml(target.name)}</span>!${note ? `<div class="text-sm text-amber-300 mt-2 italic">"${escapeHtml(note)}"</div>` : ''}`;
  } else if (type === 'REVIVE') {
    banner.className = 'transform scale-100 transition-transform duration-300 text-center px-10 py-8 rounded-3xl border-2 border-emerald-400 bg-gradient-to-b from-emerald-950/95 via-zinc-950/95 to-black/95 shadow-2xl shadow-emerald-500/50 backdrop-blur-xl';
    emoji.textContent = '⚡🔥';
    title.className = 'font-display text-6xl md:text-7xl tracking-wider uppercase text-emerald-400 drop-shadow-lg';
    title.textContent = 'BACK IN THE RING!';
    const selfRevive = actor.id === target.id;
    subtitle.innerHTML = selfRevive
      ? `<span class="text-emerald-300 font-extrabold">${escapeHtml(target.name)}</span> used their points to <span class="text-white font-extrabold">REVIVE</span>!`
      : `<span class="text-emerald-300 font-extrabold">${escapeHtml(actor.name)}</span> revived <span class="text-white font-extrabold">${escapeHtml(target.name)}</span>!`;
  } else {
    banner.className = 'transform scale-100 transition-transform duration-300 text-center px-10 py-7 rounded-3xl border-2 border-magenta bg-gradient-to-b from-magenta/30 via-zinc-950/95 to-black/95 shadow-2xl shadow-magenta/50 backdrop-blur-xl';
    emoji.textContent = '🔥⚡';
    title.className = 'font-display text-5xl md:text-6xl tracking-wider uppercase text-amber-300 drop-shadow-lg';
    title.textContent = 'POINTS LOGGED!';
    subtitle.innerHTML = `<span class="text-white font-extrabold">${escapeHtml(actor.name)}</span>: <span class="text-magenta-light font-extrabold">${escapeHtml(note)}</span>`;
  }

  overlay.classList.remove('opacity-0');
  overlay.classList.add('opacity-100');

  setTimeout(() => {
    overlay.classList.remove('opacity-100');
    overlay.classList.add('opacity-0');
  }, type === 'LINE' ? 1600 : 2500);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setCommandMode(mode) {
  state.ui.commandMode = mode;
  const tabs = {
    lines: { btn: document.getElementById('tab-mode-lines'), form: document.getElementById('form-lines'), cls: 'active-lines' },
    ko: { btn: document.getElementById('tab-mode-ko'), form: document.getElementById('form-ko'), cls: 'active-ko' },
    revive: { btn: document.getElementById('tab-mode-revive'), form: document.getElementById('form-revive'), cls: 'active-revive' },
    announce: { btn: document.getElementById('tab-mode-announce'), form: document.getElementById('form-announce'), cls: 'active-announce' }
  };

  Object.keys(tabs).forEach(k => {
    const item = tabs[k];
    if (!item.btn || !item.form) return;
    if (k === mode) {
      item.btn.className = `mode-tab ${item.cls} py-2 px-2 rounded-lg text-[11px] font-extrabold uppercase tracking-wider flex items-center justify-center gap-1 transition`;
      item.form.classList.remove('hidden');
    } else {
      item.btn.className = 'mode-tab py-2 px-2 rounded-lg text-[11px] font-extrabold uppercase tracking-wider flex items-center justify-center gap-1 transition text-zinc-400 hover:text-white';
      item.form.classList.add('hidden');
    }
  });
}

// Admin Authentication Helpers
function openAdminLoginModal() {
  const modal = document.getElementById('modal-admin-login');
  const pinInput = document.getElementById('input-admin-pin');
  const errEl = document.getElementById('admin-pin-error');
  errEl.classList.add('hidden');
  pinInput.value = '';
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  setTimeout(() => pinInput.focus(), 50);
}

function lockAdminMode() {
  state.auth.isAdmin = false;
  state.auth.pin = '';
  sessionStorage.removeItem(ADMIN_PIN_STORAGE_KEY);
  renderAll();
}

async function verifyAndUnlockAdmin(pin) {
  try {
    const res = await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify_pin', pin })
    });
    if (res.ok) {
      state.auth.isAdmin = true;
      state.auth.pin = pin;
      sessionStorage.setItem(ADMIN_PIN_STORAGE_KEY, pin);
      return true;
    }
    return false;
  } catch (err) {
    // Fallback if offline: default PIN 2026
    if (pin === '2026') {
      state.auth.isAdmin = true;
      state.auth.pin = pin;
      sessionStorage.setItem(ADMIN_PIN_STORAGE_KEY, pin);
      return true;
    }
    return false;
  }
}

// Render Everything
function renderAll() {
  const computed = getComputedStores();
  const storeById = {};
  computed.forEach(s => { storeById[s.id] = s; });

  // Toggle Admin-only visibility
  const isAdmin = state.auth.isAdmin;
  document.querySelectorAll('.admin-only').forEach(el => {
    if (isAdmin) el.classList.remove('hidden');
    else el.classList.add('hidden');
  });

  const modeBadge = document.getElementById('mode-badge');
  const adminLockIcon = document.getElementById('admin-lock-icon');
  const adminLockLabel = document.getElementById('admin-lock-label');
  if (isAdmin) {
    modeBadge.className = 'px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-widest bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 rounded-full';
    modeBadge.textContent = '🔓 ADMIN EDITOR';
    adminLockIcon.textContent = '🔓';
    adminLockLabel.textContent = 'Exit Admin';
  } else {
    modeBadge.className = 'px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-widest bg-zinc-800 text-zinc-300 border border-zinc-700 rounded-full';
    modeBadge.textContent = '👀 LIVE VIEWER';
    adminLockIcon.textContent = '🔒';
    adminLockLabel.textContent = 'Admin Login';
  }

  // Announcement Banner
  const announceBanner = document.getElementById('announcement-banner');
  const announceText = document.getElementById('announcement-text');
  if (state.announcement && state.announcement.active && state.announcement.text) {
    announceBanner.classList.remove('hidden');
    announceText.textContent = state.announcement.text;
  } else {
    announceBanner.classList.add('hidden');
  }

  // District Badge
  document.getElementById('district-badge').textContent = state.districtName;

  // Top KPI Stats
  const aliveStores = computed.filter(s => !s.isEliminated);
  const koStores = computed.filter(s => s.isEliminated);
  const totalKosAllTime = state.combatLog.filter(e => e.type === 'KO').length;
  const totalEarnedPts = computed.reduce((acc, s) => acc + s.earnedPoints, 0);
  const totalAvailPts = computed.reduce((acc, s) => acc + s.availablePoints, 0);
  const totalVl = computed.reduce((acc, s) => acc + s.vl, 0);
  const totalBeyondVl = computed.reduce((acc, s) => acc + s.beyondVl, 0);
  const totalBts = computed.reduce((acc, s) => acc + s.bts, 0);
  const totalHsi = computed.reduce((acc, s) => acc + s.hsi, 0);
  const totalAcc = computed.reduce((acc, s) => acc + s.acc, 0);
  const totalNetRev = computed.reduce((acc, s) => acc + s.netRev, 0);

  document.getElementById('stat-standing').textContent = aliveStores.length;
  document.getElementById('stat-total-stores').textContent = `/ ${computed.length} Alive`;
  document.getElementById('stat-ko').textContent = koStores.length;
  document.getElementById('stat-total-kos-alltime').textContent = `${totalKosAllTime} total KOs`;
  document.getElementById('stat-total-points').textContent = totalEarnedPts;
  document.getElementById('stat-available-points').textContent = `${totalAvailPts} avail`;
  document.getElementById('stat-vl').textContent = totalVl;
  document.getElementById('stat-bvl').textContent = `+${totalBeyondVl} Beyond`;
  document.getElementById('stat-bts').textContent = totalBts;
  document.getElementById('stat-hsi').textContent = `${totalHsi} HINTs`;
  document.getElementById('stat-acc').textContent = `$${totalAcc.toLocaleString()}`;
  document.getElementById('stat-net-rev').textContent = `$${totalNetRev.toLocaleString()} NR`;

  // Filter tab counts
  document.getElementById('count-all').textContent = computed.length;
  document.getElementById('count-alive').textContent = aliveStores.length;
  document.getElementById('count-ko').textContent = koStores.length;

  // Sole Survivor Banner
  const survivorBanner = document.getElementById('survivor-banner');
  const isSoleSurvivor = aliveStores.length === 1 && computed.length > 1;
  if (isSoleSurvivor) {
    survivorBanner.classList.remove('hidden');
    document.getElementById('survivor-name').textContent = `${aliveStores[0].emoji} ${aliveStores[0].name}`;
  } else {
    survivorBanner.classList.add('hidden');
  }

  // Cost labels
  document.getElementById('label-ko-cost').textContent = state.settings.koCost;
  document.getElementById('label-revive-cost').textContent = state.settings.reviveCost;
  document.querySelectorAll('.ko-cost-inline').forEach(el => {
    el.textContent = state.settings.koCost;
  });

  // Filter and sort stores
  let filtered = [...computed];
  if (state.ui.filter === 'alive') filtered = filtered.filter(s => !s.isEliminated);
  if (state.ui.filter === 'eliminated') filtered = filtered.filter(s => s.isEliminated);

  filtered.sort((a, b) => {
    switch (state.ui.sortBy) {
      case 'available_desc':
        return b.availablePoints - a.availablePoints || b.earnedPoints - a.earnedPoints;
      case 'earned_desc':
        return b.earnedPoints - a.earnedPoints || b.availablePoints - a.availablePoints;
      case 'alive_first':
        if (a.isEliminated !== b.isEliminated) return a.isEliminated ? 1 : -1;
        return b.availablePoints - a.availablePoints || b.earnedPoints - a.earnedPoints;
      case 'kos_desc':
        return b.kosDealt - a.kosDealt || b.availablePoints - a.availablePoints;
      case 'sheet_order':
      default:
        return a.sheetOrder - b.sheetOrder;
    }
  });

  renderStoreCards(filtered, storeById, isSoleSurvivor ? aliveStores[0].id : null);
  renderSheetTable(computed);
  renderAdminSelects(computed);
  renderActivityFeed(storeById);
}

function renderStoreCards(stores, storeById, soleSurvivorId) {
  const grid = document.getElementById('stores-grid');
  const isAdmin = state.auth.isAdmin;

  if (stores.length === 0) {
    grid.innerHTML = `
      <div class="col-span-full bg-arena-card border border-arena-border rounded-2xl p-10 text-center text-zinc-400">
        No stores match the selected filter.
      </div>
    `;
    return;
  }

  grid.innerHTML = stores.map(store => {
    const isChamp = store.id === soleSurvivorId;
    const koByStore = store.eliminatedBy ? storeById[store.eliminatedBy] : null;
    const canAffordKo = store.availablePoints >= state.settings.koCost && (!store.isEliminated || state.settings.koCanAttack);
    const canAffordRevive = store.availablePoints >= state.settings.reviveCost;
    const accProgressPct = store.acc % 100;

    return `
      <div class="store-card relative rounded-2xl border p-4 flex flex-col justify-between ${
        store.isEliminated
          ? 'is-eliminated border-red-500/40'
          : isChamp
          ? 'is-survivor bg-arena-card'
          : 'bg-arena-card border-arena-border hover:border-magenta/50'
      }">
        <div>
          <div class="flex items-start justify-between gap-2 mb-3">
            <div class="flex items-center gap-2.5">
              <div class="w-11 h-11 rounded-xl flex items-center justify-center text-2xl border ${
                store.isEliminated
                  ? 'bg-red-950/50 border-red-500/30 grayscale'
                  : 'bg-arena-elevated border-white/10'
              }">
                ${store.isEliminated ? '💀' : store.emoji}
              </div>
              <div>
                <div class="flex items-center gap-1.5">
                  <h3 class="font-display text-2xl tracking-wide leading-none ${store.isEliminated ? 'line-through text-zinc-400' : 'text-white'}">
                    ${escapeHtml(store.name)}
                  </h3>
                  ${isChamp ? '<span class="text-xs px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-300 font-bold border border-amber-400/40">👑 CHAMP</span>' : ''}
                </div>
                <div class="flex items-center gap-2 mt-1 text-[11px] text-zinc-400 font-medium">
                  <span>NR: <strong class="text-zinc-200">$${store.netRev.toLocaleString()}</strong> / $${store.nrGoal.toLocaleString()}</span>
                  <span>•</span>
                  <span>PP: <strong class="text-zinc-200">${store.totalPP}</strong>/${store.postGoal}</span>
                </div>
              </div>
            </div>

            ${
              store.isEliminated
                ? `<span class="px-2.5 py-1 rounded-full text-[10px] font-extrabold uppercase tracking-wider bg-red-500/20 text-red-300 border border-red-500/40 flex items-center gap-1 shrink-0">
                     💀 KNOCKED OUT
                   </span>`
                : `<span class="px-2.5 py-1 rounded-full text-[10px] font-extrabold uppercase tracking-wider bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1 shrink-0">
                     <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span> IN THE RING
                   </span>`
            }
          </div>

          ${
            store.isEliminated
              ? `<div class="mb-3 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/30 text-xs flex items-center justify-between gap-2">
                   <div class="text-red-200">
                     Knocked out by <strong class="text-white">${koByStore ? escapeHtml(koByStore.name) : 'Rival'}</strong>
                     ${store.eliminatedNote ? `<span class="block text-[11px] text-amber-300 italic mt-0.5">"${escapeHtml(store.eliminatedNote)}"</span>` : ''}
                   </div>
                   ${
                     isAdmin
                       ? `<button onclick="quickSelectAction('${store.id}', 'revive')"
                                  class="shrink-0 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold text-[11px] uppercase tracking-wider transition shadow">
                            ⚡ Revive (${state.settings.reviveCost}pt)
                          </button>`
                       : ''
                   }
                 </div>`
              : ''
          }

          <!-- Point Power Meter -->
          <div class="grid grid-cols-3 gap-2 p-2.5 rounded-xl bg-arena-bg/90 border border-arena-border mb-3">
            <div class="text-center border-r border-arena-border pr-2">
              <div class="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Available</div>
              <div class="font-display text-3xl leading-tight ${store.availablePoints > 0 ? 'text-amber-400' : 'text-zinc-500'}">
                ${store.availablePoints} <span class="text-xs font-sans font-bold">PTS</span>
              </div>
            </div>
            <div class="text-center border-r border-arena-border pr-2">
              <div class="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Earned / Spent</div>
              <div class="font-mono text-sm font-extrabold text-zinc-200 mt-1">
                <span class="text-emerald-400">${store.earnedPoints}</span>
                <span class="text-zinc-500">/</span>
                <span class="text-red-400">${store.pointsSpent}</span>
              </div>
            </div>
            <div class="text-center">
              <div class="text-[10px] font-bold uppercase tracking-wider text-zinc-400">KOs / Revives</div>
              <div class="font-mono text-sm font-extrabold text-zinc-200 mt-1">
                🥊 ${store.kosDealt} <span class="text-zinc-600">|</span> ⚡ ${store.timesRevived}
              </div>
            </div>
          </div>

          <!-- 1-Point & 2-Point Metric Breakdown Pills -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[11px] mb-3">
            <div class="bg-arena-elevated/70 border border-white/5 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
              <span class="text-zinc-400">VL <span class="text-[9px] text-zinc-500">(1pt)</span></span>
              <span class="font-mono font-bold text-white">${store.vl} <span class="text-amber-400 text-[10px]">+${store.vlPts}</span></span>
            </div>

            <div class="bg-magenta/10 border border-magenta/30 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
              <span class="text-magenta-light font-semibold">B.VL <span class="text-[9px]">(2pt)</span></span>
              <span class="font-mono font-bold text-white">${store.beyondVl} <span class="text-pink-300 text-[10px]">+${store.beyondVlPts}</span></span>
            </div>

            <div class="bg-arena-elevated/70 border border-white/5 rounded-lg px-2.5 py-1.5 flex items-center justify-between" title="Watches & Tablets (1 pt each)">
              <span class="text-zinc-400">BTS <span class="text-[9px] text-zinc-500">(1pt)</span></span>
              <span class="font-mono font-bold text-cyan-300">${store.bts} <span class="text-amber-400 text-[10px]">+${store.btsPts}</span></span>
            </div>

            <div class="bg-arena-elevated/70 border border-white/5 rounded-lg px-2.5 py-1.5 flex items-center justify-between" title="HINT / HSI (2 pts each)">
              <span class="text-zinc-400">HINT <span class="text-[9px] text-zinc-500">(2pt)</span></span>
              <span class="font-mono font-bold text-purple-300">${store.hsi} <span class="text-amber-400 text-[10px]">+${store.hsiPts}</span></span>
            </div>
          </div>

          <!-- Accessories Progress Bar -->
          <div class="bg-arena-elevated/50 border border-white/5 rounded-xl p-2.5">
            <div class="flex items-center justify-between text-[11px] mb-1">
              <span class="text-zinc-300 font-semibold">
                🎧 Accessories: <strong class="text-pink-400">$${store.acc.toLocaleString()}</strong>
                <span class="text-zinc-500">/ $${store.accGoal.toLocaleString()}</span>
              </span>
              <span class="font-mono font-bold text-amber-300">
                +${store.accPts} pt${store.accPts === 1 ? '' : 's'}
                <span class="text-[10px] text-zinc-400 font-normal">($${store.accNextHundred} to next)</span>
              </span>
            </div>
            <div class="w-full h-1.5 bg-arena-bg rounded-full overflow-hidden">
              <div class="h-full bg-gradient-to-r from-magenta to-amber-400 rounded-full transition-all duration-500" style="width: ${accProgressPct}%"></div>
            </div>
          </div>
        </div>

        <!-- Admin Action Buttons on Card (Only shown when Admin is logged in) -->
        ${
          isAdmin
            ? `<div class="flex items-center gap-1.5 pt-3 mt-3 border-t border-arena-border/60">
                 <button onclick="quickSelectAction('${store.id}', 'add_line')"
                         class="py-2 px-2.5 rounded-xl bg-magenta/20 hover:bg-magenta/35 border border-magenta/40 text-pink-200 text-[11px] font-extrabold uppercase tracking-wider transition">
                   ➕ Add Line
                 </button>
                 ${
                   !store.isEliminated
                     ? `<button onclick="quickSelectAction('${store.id}', 'attack')"
                                ${!canAffordKo ? 'disabled' : ''}
                                class="flex-1 py-2 px-2.5 rounded-xl text-[11px] font-extrabold uppercase tracking-wider transition ${
                                  canAffordKo
                                    ? 'bg-gradient-to-r from-red-600 to-magenta text-white shadow'
                                    : 'bg-arena-elevated text-zinc-500 cursor-not-allowed'
                                }">
                          🥊 Knock Out
                        </button>
                        <button onclick="quickSelectAction('${store.id}', 'target')"
                                class="py-2 px-2.5 rounded-xl bg-arena-elevated hover:bg-red-500/20 border border-arena-border text-zinc-300 hover:text-red-300 text-[11px] font-bold transition">
                          🎯
                        </button>`
                     : `<button onclick="quickSelectAction('${store.id}', 'revive')"
                                class="flex-1 py-2 px-2.5 rounded-xl text-[11px] font-extrabold uppercase tracking-wider transition ${
                                  canAffordRevive
                                    ? 'bg-gradient-to-r from-emerald-600 to-teal-500 text-white shadow'
                                    : 'bg-arena-elevated text-emerald-300 border border-emerald-500/30'
                                }">
                          ⚡ Revive Store
                        </button>`
                 }
               </div>`
            : ''
        }
      </div>
    `;
  }).join('');
}

function renderSheetTable(computed) {
  const tbody = document.getElementById('sheet-table-body');
  const isAdmin = state.auth.isAdmin;

  const cellStepper = (storeId, field, displayVal, colorClass) => {
    if (!isAdmin) {
      return `<span class="font-mono font-bold ${colorClass}">${displayVal}</span>`;
    }
    const step = field === 'acc' ? 100 : 1;
    return `
      <div class="inline-flex items-center gap-1">
        <button onclick="adjustStoreManual('${storeId}', '${field}', -${step})" class="w-5 h-5 rounded bg-arena-elevated hover:bg-red-500/30 text-zinc-300 leading-none">−</button>
        <span class="font-mono font-bold ${colorClass} min-w-[24px] text-center">${displayVal}</span>
        <button onclick="adjustStoreManual('${storeId}', '${field}', ${step})" class="w-5 h-5 rounded bg-arena-elevated hover:bg-emerald-500/30 text-zinc-300 leading-none">+</button>
      </div>
    `;
  };

  tbody.innerHTML = computed.map(store => {
    return `
      <tr class="hover:bg-arena-elevated/40 transition ${store.isEliminated ? 'opacity-60 bg-red-950/10' : ''}">
        <td class="py-2.5 px-4 font-semibold text-white whitespace-nowrap">
          <span class="mr-1.5">${store.isEliminated ? '💀' : store.emoji}</span>
          <span class="${store.isEliminated ? 'line-through text-zinc-400' : ''}">${escapeHtml(store.name)}</span>
        </td>
        <td class="py-2.5 px-2 text-center">
          ${
            store.isEliminated
              ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-500/20 text-red-300">KO</span>'
              : '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300">ALIVE</span>'
          }
        </td>
        <td class="py-2.5 px-2 text-center">${cellStepper(store.id, 'vl', store.vl, 'text-zinc-200')}</td>
        <td class="py-2.5 px-2 text-center bg-magenta/5">${cellStepper(store.id, 'beyondVl', store.beyondVl, 'text-magenta-light')}</td>
        <td class="py-2.5 px-2 text-center">${cellStepper(store.id, 'watches', store.bts, 'text-cyan-300')}</td>
        <td class="py-2.5 px-2 text-center">${cellStepper(store.id, 'hsi', store.hsi, 'text-purple-300')}</td>
        <td class="py-2.5 px-2 text-right">${cellStepper(store.id, 'acc', '$' + store.acc.toLocaleString(), 'text-pink-300')}</td>
        <td class="py-2.5 px-2 text-center">${cellStepper(store.id, 'bonusPts', store.bonusPts > 0 ? '+' + store.bonusPts : store.bonusPts, 'text-zinc-200')}</td>
        <td class="py-2.5 px-2 text-center font-mono font-bold text-amber-300">${store.earnedPoints}</td>
        <td class="py-2.5 px-2 text-center font-mono text-red-400">${store.pointsSpent}</td>
        <td class="py-2.5 px-3 text-center font-mono font-extrabold text-sm ${store.availablePoints > 0 ? 'text-emerald-400' : 'text-zinc-500'}">${store.availablePoints}</td>
      </tr>
    `;
  }).join('');
}

function renderAdminSelects(computed) {
  const selectLineStore = document.getElementById('select-line-store');
  const selectAttacker = document.getElementById('select-attacker');
  const selectTarget = document.getElementById('select-target');
  const selectReviveTarget = document.getElementById('select-revive-target');
  const selectRevivePayer = document.getElementById('select-revive-payer');

  if (!selectLineStore) return;

  const prevLineStore = selectLineStore.value;
  const prevAttacker = selectAttacker.value;
  const prevTarget = selectTarget.value;
  const prevReviveTarget = selectReviveTarget.value;
  const prevRevivePayer = selectRevivePayer.value;

  // Store selector for Manual Line Entry
  selectLineStore.innerHTML = computed
    .map(s => `<option value="${s.id}">${s.emoji} ${escapeHtml(s.name)} (${s.availablePoints} pts avail)</option>`)
    .join('');
  if (prevLineStore && computed.some(s => s.id === prevLineStore)) {
    selectLineStore.value = prevLineStore;
  }

  const koCost = Number(state.settings.koCost || 1);
  const reviveCost = Number(state.settings.reviveCost || 1);

  const attackers = computed.filter(s => s.availablePoints >= koCost && (!s.isEliminated || state.settings.koCanAttack));
  selectAttacker.innerHTML = attackers.length
    ? attackers.map(s => `<option value="${s.id}">${s.emoji} ${escapeHtml(s.name)} (${s.availablePoints} pts avail)</option>`).join('')
    : `<option value="">No stores have ${koCost}+ available points</option>`;
  if (prevAttacker && attackers.some(s => s.id === prevAttacker)) {
    selectAttacker.value = prevAttacker;
  }

  const aliveTargets = computed.filter(s => !s.isEliminated);
  selectTarget.innerHTML = aliveTargets.length
    ? aliveTargets.map(s => `<option value="${s.id}">🎯 ${escapeHtml(s.name)} (${s.availablePoints} pts)</option>`).join('')
    : `<option value="">No standing stores left!</option>`;
  if (prevTarget && aliveTargets.some(s => s.id === prevTarget)) {
    selectTarget.value = prevTarget;
  } else if (aliveTargets.length > 1 && selectAttacker.value === selectTarget.value) {
    const diffTarget = aliveTargets.find(t => t.id !== selectAttacker.value);
    if (diffTarget) selectTarget.value = diffTarget.id;
  }

  const koTargets = computed.filter(s => s.isEliminated);
  selectReviveTarget.innerHTML = koTargets.length
    ? koTargets.map(s => `<option value="${s.id}">💀 ${escapeHtml(s.name)} (${s.availablePoints} pts avail)</option>`).join('')
    : `<option value="">All stores are currently standing! 🛡️</option>`;
  if (prevReviveTarget && koTargets.some(s => s.id === prevReviveTarget)) {
    selectReviveTarget.value = prevReviveTarget;
  }

  const payers = computed.filter(s => s.availablePoints >= reviveCost);
  selectRevivePayer.innerHTML = payers.length
    ? payers.map(s => `<option value="${s.id}">${s.emoji} ${escapeHtml(s.name)} (${s.availablePoints} pts avail)</option>`).join('')
    : `<option value="">No stores have ${reviveCost}+ available points</option>`;
  if (prevRevivePayer && payers.some(s => s.id === prevRevivePayer)) {
    selectRevivePayer.value = prevRevivePayer;
  } else if (selectReviveTarget.value && payers.some(s => s.id === selectReviveTarget.value)) {
    selectRevivePayer.value = selectReviveTarget.value;
  }
}

function renderActivityFeed(storeById) {
  const feedEl = document.getElementById('combat-feed');
  const feedCount = document.getElementById('feed-count');
  const undoBtn = document.getElementById('btn-undo-last');
  const isAdmin = state.auth.isAdmin;

  // Combine combatLog and salesLog chronologically
  const combined = [
    ...state.combatLog.map(e => ({ ...e, feedCategory: 'COMBAT' })),
    ...state.salesLog.map(s => ({ ...s, feedCategory: 'SALE' }))
  ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  feedCount.textContent = combined.length;
  undoBtn.disabled = state.combatLog.length === 0;

  if (combined.length === 0) {
    feedEl.innerHTML = `
      <div class="text-center py-8 px-4 text-zinc-500 text-xs">
        <div class="text-3xl mb-2">🥊👀</div>
        <div class="font-bold text-zinc-300">WHO’S GETTING KNOCKED OUT FIRST?!</div>
        <p class="mt-1">Live Knockouts, Revives, and newly logged store lines will appear here automatically!</p>
      </div>
    `;
    return;
  }

  feedEl.innerHTML = combined.map(evt => {
    const timeStr = new Date(evt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (evt.feedCategory === 'SALE') {
      const store = storeById[evt.storeId] || { name: evt.storeId, emoji: '🏪' };
      const meta = LINE_LABELS[evt.category] || { name: evt.category, emoji: '⚡', ptsUnit: '' };
      const displayQty = evt.category === 'acc' ? `$${evt.qty}` : `${evt.qty > 0 ? '+' : ''}${evt.qty}`;
      return `
        <div class="p-2.5 rounded-xl bg-arena-elevated/80 border border-white/10 flex items-start justify-between gap-2 text-xs">
          <div>
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="font-extrabold text-amber-300 uppercase tracking-wider">${meta.emoji} LINE ADDED</span>
              <span class="text-[10px] text-zinc-500 font-mono">${timeStr}</span>
            </div>
            <div class="mt-0.5 text-zinc-200">
              <strong class="text-white">${escapeHtml(store.name)}</strong> logged <strong class="text-magenta-light">${displayQty} ${escapeHtml(meta.name)}</strong>
            </div>
            ${evt.note ? `<div class="mt-0.5 text-[11px] text-zinc-400">${escapeHtml(evt.note)}</div>` : ''}
          </div>
          ${isAdmin ? `<button onclick="deleteSaleEvent('${evt.id}')" class="text-zinc-500 hover:text-red-400 p-1" title="Undo & remove line">✕</button>` : ''}
        </div>
      `;
    }

    const actor = storeById[evt.attackerId] || { name: evt.attackerId, emoji: '🥊' };
    const target = storeById[evt.targetId] || { name: evt.targetId, emoji: '🎯' };

    if (evt.type === 'KO') {
      return `
        <div class="p-3 rounded-xl bg-red-500/10 border border-red-500/30 flex items-start justify-between gap-2 text-xs">
          <div>
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="font-extrabold text-red-400 uppercase tracking-wider">🥊 KNOCKOUT!</span>
              <span class="text-[10px] text-zinc-500 font-mono">${timeStr}</span>
              <span class="text-[10px] px-1.5 py-0.2 rounded bg-red-500/20 text-red-300 font-mono">-${evt.cost} pt</span>
            </div>
            <div class="mt-1 text-zinc-200">
              <strong class="text-white">${escapeHtml(actor.name)}</strong> eliminated <strong class="text-red-300">${escapeHtml(target.name)}</strong>!
            </div>
            ${evt.note ? `<div class="mt-1 text-[11px] italic text-amber-300">"${escapeHtml(evt.note)}"</div>` : ''}
          </div>
          ${isAdmin ? `<button onclick="deleteCombatEvent('${evt.id}')" class="text-zinc-500 hover:text-red-400 p-1" title="Remove entry">✕</button>` : ''}
        </div>
      `;
    } else {
      const selfRevive = evt.attackerId === evt.targetId;
      return `
        <div class="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-start justify-between gap-2 text-xs">
          <div>
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="font-extrabold text-emerald-400 uppercase tracking-wider">⚡ REVIVED!</span>
              <span class="text-[10px] text-zinc-500 font-mono">${timeStr}</span>
              <span class="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 font-mono">-${evt.cost} pt</span>
            </div>
            <div class="mt-1 text-zinc-200">
              ${
                selfRevive
                  ? `<strong class="text-emerald-300">${escapeHtml(target.name)}</strong> fought their way back into the competition!`
                  : `<strong class="text-white">${escapeHtml(actor.name)}</strong> revived <strong class="text-emerald-300">${escapeHtml(target.name)}</strong>!`
              }
            </div>
            ${evt.note ? `<div class="mt-1 text-[11px] italic text-emerald-200">"${escapeHtml(evt.note)}"</div>` : ''}
          </div>
          ${isAdmin ? `<button onclick="deleteCombatEvent('${evt.id}')" class="text-zinc-500 hover:text-red-400 p-1" title="Remove entry">✕</button>` : ''}
        </div>
      `;
    }
  }).join('');
}

// DOM Event Listeners
document.addEventListener('DOMContentLoaded', () => {
  loadLocalCache();

  // Check URL query ?admin=1 for quick login prompt
  if (window.location.search.includes('admin') && !state.auth.isAdmin) {
    setTimeout(openAdminLoginModal, 300);
  }

  // Filter buttons
  document.querySelectorAll('.filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.ui.filter = btn.getAttribute('data-filter');
      renderAll();
    });
  });

  // Sort select
  document.getElementById('sort-select').addEventListener('change', e => {
    state.ui.sortBy = e.target.value;
    renderAll();
  });

  // Admin Mode Tabs
  document.getElementById('tab-mode-lines')?.addEventListener('click', () => setCommandMode('lines'));
  document.getElementById('tab-mode-ko')?.addEventListener('click', () => setCommandMode('ko'));
  document.getElementById('tab-mode-revive')?.addEventListener('click', () => setCommandMode('revive'));
  document.getElementById('tab-mode-announce')?.addEventListener('click', () => setCommandMode('announce'));

  // Custom Line Submit
  document.getElementById('btn-submit-custom-line')?.addEventListener('click', () => {
    const category = document.getElementById('select-custom-line-type').value;
    const qty = parseFloat(document.getElementById('input-custom-line-qty').value);
    const noteInput = document.getElementById('input-custom-line-note');
    if (isNaN(qty) || qty === 0) {
      alert('Enter a valid quantity or dollar amount!');
      return;
    }
    window.quickLogSale(category, qty, (noteInput.value || '').trim());
    noteInput.value = '';
  });

  // Broadcast Announcement handlers
  document.getElementById('btn-post-announce')?.addEventListener('click', () => {
    const txt = (document.getElementById('input-announce-text').value || '').trim();
    if (!txt) return;
    state.announcement = { text: txt, active: true, updatedAt: new Date().toISOString() };
    pushServerState();
  });
  const clearAnnounce = () => {
    state.announcement = { text: '', active: false, updatedAt: new Date().toISOString() };
    pushServerState();
  };
  document.getElementById('btn-remove-announce')?.addEventListener('click', clearAnnounce);
  document.getElementById('btn-clear-announcement')?.addEventListener('click', clearAnnounce);

  // Add Custom Store Row
  document.getElementById('btn-add-custom-store')?.addEventListener('click', () => {
    const idInput = document.getElementById('input-new-store-id');
    const nameInput = document.getElementById('input-new-store-name');
    const id = (idInput.value || '').trim().toUpperCase();
    const teamName = (nameInput.value || '').trim();
    if (!id || !teamName) {
      alert('Enter both a Store ID and Team Name!');
      return;
    }
    state.customStores.push({
      id,
      name: `${id} - ${teamName}`,
      emoji: '🔥'
    });
    idInput.value = '';
    nameInput.value = '';
    pushServerState();
  });

  // Execute KO & Revive
  document.getElementById('btn-execute-ko').addEventListener('click', executeKnockout);
  document.getElementById('btn-execute-revive').addEventListener('click', executeRevive);
  document.getElementById('btn-undo-last').addEventListener('click', undoLastAction);

  // Sync Now
  document.getElementById('btn-sync-now').addEventListener('click', syncAll);

  // Admin Login / Logout Button
  document.getElementById('btn-admin-toggle').addEventListener('click', () => {
    if (state.auth.isAdmin) {
      lockAdminMode();
    } else {
      openAdminLoginModal();
    }
  });

  document.getElementById('btn-close-admin-login').addEventListener('click', () => {
    const m = document.getElementById('modal-admin-login');
    m.classList.add('hidden');
    m.classList.remove('flex');
  });

  document.getElementById('form-admin-pin').addEventListener('submit', async e => {
    e.preventDefault();
    const pin = document.getElementById('input-admin-pin').value.trim();
    const ok = await verifyAndUnlockAdmin(pin);
    if (ok) {
      const m = document.getElementById('modal-admin-login');
      m.classList.add('hidden');
      m.classList.remove('flex');
      renderAll();
    } else {
      document.getElementById('admin-pin-error').classList.remove('hidden');
    }
  });

  // Sound toggle
  const soundBtn = document.getElementById('btn-sound-toggle');
  const updateSoundBtn = () => {
    soundBtn.textContent = state.settings.soundEnabled ? '🔊' : '🔇';
  };
  updateSoundBtn();
  soundBtn.addEventListener('click', () => {
    state.settings.soundEnabled = !state.settings.soundEnabled;
    updateSoundBtn();
  });

  // Modals
  const modalRules = document.getElementById('modal-rules');
  const modalSettings = document.getElementById('modal-settings');

  document.getElementById('btn-open-rules').addEventListener('click', () => {
    modalRules.classList.remove('hidden');
    modalRules.classList.add('flex');
  });
  document.getElementById('btn-close-rules').addEventListener('click', () => {
    modalRules.classList.add('hidden');
    modalRules.classList.remove('flex');
  });

  document.getElementById('btn-open-settings').addEventListener('click', () => {
    document.getElementById('setting-ko-cost').value = state.settings.koCost;
    document.getElementById('setting-revive-cost').value = state.settings.reviveCost;
    document.getElementById('setting-ko-can-attack').checked = state.settings.koCanAttack;
    document.getElementById('setting-sheet-url').value = state.settings.sheetUrl;
    modalSettings.classList.remove('hidden');
    modalSettings.classList.add('flex');
  });
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    modalSettings.classList.add('hidden');
    modalSettings.classList.remove('flex');
  });

  document.getElementById('btn-save-settings').addEventListener('click', () => {
    state.settings.koCost = Math.max(1, parseInt(document.getElementById('setting-ko-cost').value, 10) || 1);
    state.settings.reviveCost = Math.max(1, parseInt(document.getElementById('setting-revive-cost').value, 10) || 1);
    state.settings.koCanAttack = document.getElementById('setting-ko-can-attack').checked;
    state.settings.sheetUrl = document.getElementById('setting-sheet-url').value.trim() || state.settings.sheetUrl;
    modalSettings.classList.add('hidden');
    modalSettings.classList.remove('flex');
    pushServerState();
    syncAll();
  });

  document.getElementById('btn-reset-combat').addEventListener('click', () => {
    if (confirm('Reset all manually logged lines, Knockouts, and Revives on the server back to fresh?')) {
      state.combatLog = [];
      state.salesLog = [];
      state.manualLines = {};
      state.customStores = [];
      state.announcement = { text: '', active: false, updatedAt: null };
      modalSettings.classList.add('hidden');
      modalSettings.classList.remove('flex');
      pushServerState();
    }
  });

  // Initial render + Server & Sheet sync + live polling
  renderAll();
  syncAll();
  // Poll shared server state every 8 seconds so viewers see Admin changes in near real-time
  setInterval(() => fetchServerState(true), 8000);
  // Poll Google Sheet every 60 seconds
  setInterval(syncAll, 60000);
});
