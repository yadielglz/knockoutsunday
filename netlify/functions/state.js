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
  // Manual adjustments & manually logged sales lines per store
  // { [storeId]: { vl: 0, beyondVl: 0, watches: 0, tablets: 0, hsi: 0, acc: 0, bonusPts: 0 } }
  manualLines: {},
  // History of individual manual line additions so admin can see/undo them
  // [ { id, timestamp, storeId, category, qty, amount, points, note } ]
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

// In-memory fallback if Netlify Blobs isn't available in a custom environment
let memoryFallbackState = JSON.parse(JSON.stringify(INITIAL_STATE));

async function readSharedState() {
  try {
    const store = getStore({ name: 'knockout-sunday', consistency: 'strong' });
    const data = await store.get('arena-state', { type: 'json' });
    if (data && typeof data === 'object') {
      return { ...INITIAL_STATE, ...data };
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

      // Verify PIN endpoint
      if (body.action === 'verify_pin') {
        const valid = String(providedPin).trim() === String(DEFAULT_PIN).trim();
        return {
          statusCode: valid ? 200 : 401,
          headers,
          body: JSON.stringify({ ok: valid, error: valid ? null : 'Invalid Admin PIN' })
        };
      }

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
