const { getStore } = require('@netlify/blobs');

const DEFAULT_PIN = process.env.ADMIN_PIN || '2026';

const INITIAL_STATE = {
  version: 1,
  updatedAt: new Date().toISOString(),
  districtName: 'PHOENIX DISTRICT',
  announcement: {
    text: '',
    active: false,
    updatedAt: null
  },
  // 5-Minute Live Battle Window State
  battleWindow: {
    active: false,
    startedAt: null,
    endsAt: null,
    durationSeconds: 300
  },
  // Manual adjustments & manually logged sales lines per store
  // { [storeId]: { vl: 0, beyondVl: 0, watches: 0, tablets: 0, hsi: 0, acc: 0, bonusPts: 0 } }
  manualLines: {},
  // History of individual manual line additions
  // [ { id, timestamp, storeId, category, qty, note } ]
  salesLog: [],
  // Combat events: [ { id, timestamp, type: 'KO' | 'REVIVE', attackerId, targetId, cost, note } ]
  combatLog: [],
  // Custom stores added manually by Admin
  customStores: [],
  settings: {
    koCost: 1,
    reviveCost: 1,
    koCanAttack: false,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/1hJuUd6UkzfWBeTywVM6Yi5g0BxJodsNLe0XHgt-9nOQ/edit?gid=1896995460'
  }
};

let memoryFallbackState = JSON.parse(JSON.stringify(INITIAL_STATE));

async function readSharedState() {
  try {
    const store = getStore({ name: 'knockout-sunday', consistency: 'strong' });
    const data = await store.get('arena-state', { type: 'json' });
    if (data && typeof data === 'object') {
      return {
        ...INITIAL_STATE,
        ...data,
        battleWindow: { ...INITIAL_STATE.battleWindow, ...(data.battleWindow || {}) },
        settings: { ...INITIAL_STATE.settings, ...(data.settings || {}) }
      };
    }
  } catch (err) {
    // Fallback to memory state
  }
  return memoryFallbackState;
}

async function writeSharedState(newState) {
  const stamped = {
    ...INITIAL_STATE,
    ...newState,
    version: (Number(newState.version) || 1) + 1,
    updatedAt: new Date().toISOString()
  };
  memoryFallbackState = stamped;
  try {
    const store = getStore({ name: 'knockout-sunday', consistency: 'strong' });
    await store.setJSON('arena-state', stamped);
  } catch (err) {
    console.warn('Blob storage write fallback:', err.message);
  }
  return stamped;
}

function isBattleWindowCurrentlyOpen(state) {
  if (!state.battleWindow || !state.battleWindow.active || !state.battleWindow.endsAt) {
    return false;
  }
  const endsMs = new Date(state.battleWindow.endsAt).getTime();
  return Date.now() < endsMs;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-pin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod === 'GET') {
    const currentState = await readSharedState();
    // Auto-expire battleWindow if timer passed
    if (currentState.battleWindow?.active && !isBattleWindowCurrentlyOpen(currentState)) {
      currentState.battleWindow.active = false;
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(currentState)
    };
  }

  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      const providedPin = event.headers['x-admin-pin'] || body.pin || '';

      // 1. Verify Admin PIN
      if (body.action === 'verify_pin') {
        const valid = String(providedPin).trim() === String(DEFAULT_PIN).trim();
        return {
          statusCode: valid ? 200 : 401,
          headers,
          body: JSON.stringify({ ok: valid, error: valid ? null : 'Invalid Admin PIN' })
        };
      }

      // 2. Public Store Combat Action (Allowed ONLY while the 5-Minute Battle Window is open!)
      if (body.action === 'store_combat') {
        const currentState = await readSharedState();
        if (!isBattleWindowCurrentlyOpen(currentState)) {
          return {
            statusCode: 403,
            headers,
            body: JSON.stringify({ error: 'The 5-Minute Battle Window is currently CLOSED! Wait for Admin to open Knockouts.' })
          };
        }

        const evtType = body.type === 'REVIVE' ? 'REVIVE' : 'KO';
        const attackerId = String(body.attackerId || '').trim();
        const targetId = String(body.targetId || '').trim();
        const note = String(body.note || '').trim().slice(0, 120);
        const cost = evtType === 'REVIVE'
          ? Number(currentState.settings?.reviveCost || 1)
          : Number(currentState.settings?.koCost || 1);

        if (!attackerId || !targetId) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Both attackerId and targetId are required.' })
          };
        }
        if (evtType === 'KO' && attackerId === targetId) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Your store cannot knock itself out!' })
          };
        }

        const newEvt = {
          id: 'evt_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
          timestamp: new Date().toISOString(),
          type: evtType,
          attackerId,
          targetId,
          cost,
          note,
          submittedByStore: true
        };

        currentState.combatLog = Array.isArray(currentState.combatLog) ? currentState.combatLog : [];
        currentState.combatLog.push(newEvt);

        const saved = await writeSharedState(currentState);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(saved)
        };
      }

      // 3. Admin Full State Update (Requires PIN)
      if (String(providedPin).trim() !== String(DEFAULT_PIN).trim()) {
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ error: 'Unauthorized: Invalid Admin PIN' })
        };
      }

      const nextState = body.state || {};
      const saved = await writeSharedState(nextState);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(saved)
      };
    } catch (err) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: err.message || 'Bad request' })
      };
    }
  }

  return {
    statusCode: 405,
    headers,
    body: JSON.stringify({ error: 'Method Not Allowed' })
  };
};
