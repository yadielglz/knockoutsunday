/**
 * Knockout Blitz — Server-Side Admin & Store Authorization
 *
 * Configuration:
 * - Admin PIN defaults to '2626' (can be overridden via process.env.ADMIN_PIN).
 * - Store actions do NOT require a store password/login by default; stores select their store ID directly.
 */

const crypto = require('crypto');

const DEFAULT_ADMIN_PIN = '2626';

function getConfiguredAdminPin() {
  const pin = process.env.ADMIN_PIN;
  if (pin && typeof pin === 'string' && pin.trim().length > 0) {
    return pin.trim();
  }
  return DEFAULT_ADMIN_PIN;
}

function getSigningSecret() {
  const secret = process.env.TOKEN_SECRET || getConfiguredAdminPin();
  return secret.trim();
}

function getEnvStoreAccessCodes() {
  const raw = process.env.STORE_ACCESS_CODES;
  if (!raw || !raw.trim()) return {};
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      return {};
    }
  }
  const map = {};
  for (const pair of trimmed.split(',')) {
    const [id, code] = pair.split(':').map(s => (s || '').trim());
    if (id && code) {
      map[id.toUpperCase()] = code;
    }
  }
  return map;
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function signPayload(payloadObj) {
  const secret = getSigningSecret();
  if (!secret) return null;
  const data = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySignedToken(token) {
  const secret = getSigningSecret();
  if (!secret || !token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  if (!timingSafeEqualStr(sig, expectedSig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function verifyAdminRequest(headers = {}, body = {}) {
  const configuredPin = getConfiguredAdminPin();

  const normalizedHeaders = {};
  for (const [k, v] of Object.entries(headers || {})) {
    normalizedHeaders[k.toLowerCase()] = v;
  }

  const token = normalizedHeaders['x-admin-token'] || body.adminToken;
  if (token) {
    const payload = verifySignedToken(token);
    if (payload && payload.role === 'admin') {
      return { authorized: true, role: 'admin' };
    }
  }

  const providedPin = String(normalizedHeaders['x-admin-pin'] || body.pin || '').trim();
  if (providedPin && timingSafeEqualStr(providedPin, configuredPin)) {
    return {
      authorized: true,
      role: 'admin',
      token: signPayload({ role: 'admin', iat: Date.now(), exp: Date.now() + 24 * 3600 * 1000 })
    };
  }

  return {
    authorized: false,
    unconfigured: false,
    error: 'Unauthorized: Valid Admin PIN required.'
  };
}

function getEffectiveStoreAccessCode(state, storeId) {
  const id = String(storeId || '').toUpperCase();
  const envCodes = getEnvStoreAccessCodes();
  if (envCodes[id]) return String(envCodes[id]);
  if (state && state.storeAccessCodes && state.storeAccessCodes[id]) {
    return String(state.storeAccessCodes[id]);
  }
  return null;
}

function authenticateStoreCredentials(state, storeId, accessCode) {
  const id = String(storeId || '').trim().toUpperCase();
  if (!id || (state?.stores && !state.stores[id])) {
    return {
      authorized: false,
      unconfigured: false,
      error: `Invalid store ID: ${id}`
    };
  }

  const expectedCode = getEffectiveStoreAccessCode(state, id);
  if (expectedCode) {
    const provided = String(accessCode || '').trim();
    if (!provided || !timingSafeEqualStr(provided, expectedCode)) {
      return {
        authorized: false,
        unconfigured: false,
        error: `Invalid Store Access Code for store ${id}.`
      };
    }
  }

  const codeHash = expectedCode
    ? crypto.createHash('sha256').update(expectedCode).digest('hex').slice(0, 12)
    : 'open';
  const token = signPayload({
    role: 'store',
    storeId: id,
    codeHash,
    iat: Date.now(),
    exp: Date.now() + 24 * 3600 * 1000
  });

  return {
    authorized: true,
    storeId: id,
    token
  };
}

/**
 * Verify a store-initiated request.
 * No store login is required when store access codes are not set: any valid storeId can act directly.
 * If a store token or store access code is configured, it is still validated.
 */
function verifyStoreActionRequest(state, headers = {}, body = {}) {
  const normalizedHeaders = {};
  for (const [k, v] of Object.entries(headers || {})) {
    normalizedHeaders[k.toLowerCase()] = v;
  }

  // 1. Check if Admin is executing on behalf of a store
  const adminCheck = verifyAdminRequest(headers, body);
  if (adminCheck.authorized && (body.storeId || body.attackerId)) {
    return {
      authorized: true,
      storeId: String(body.storeId || body.attackerId).trim().toUpperCase(),
      viaAdmin: true
    };
  }

  // 2. Check signed store token if provided
  const storeToken = normalizedHeaders['x-store-token'] || body.storeToken;
  if (storeToken) {
    const payload = verifySignedToken(storeToken);
    if (payload && payload.role === 'store' && payload.storeId) {
      const requestedStoreId = String(body.storeId || body.attackerId || payload.storeId).trim().toUpperCase();
      if (requestedStoreId !== payload.storeId) {
        return {
          authorized: false,
          error: `Store token belongs to ${payload.storeId} and cannot act on behalf of ${requestedStoreId}.`
        };
      }
      return {
        authorized: true,
        storeId: payload.storeId,
        viaToken: true
      };
    }
  }

  // 3. Direct store selection (no store login required unless a code is explicitly configured for that store)
  const candidateStoreId = String(body.storeId || body.attackerId || normalizedHeaders['x-store-id'] || '').trim().toUpperCase();
  if (!candidateStoreId || (state?.stores && !state.stores[candidateStoreId])) {
    return {
      authorized: false,
      error: 'Please select your store first.'
    };
  }

  const expectedCode = getEffectiveStoreAccessCode(state, candidateStoreId);
  if (expectedCode) {
    const candidateCode = normalizedHeaders['x-store-access-code'] || body.storeAccessCode;
    return authenticateStoreCredentials(state, candidateStoreId, candidateCode);
  }

  return {
    authorized: true,
    storeId: candidateStoreId,
    viaOpenStoreSelection: true
  };
}

module.exports = {
  DEFAULT_ADMIN_PIN,
  getConfiguredAdminPin,
  getEnvStoreAccessCodes,
  verifyAdminRequest,
  authenticateStoreCredentials,
  verifyStoreActionRequest,
  getEffectiveStoreAccessCode
};
