/**
 * Knockout Blitz — Unified Server API Controller
 * Used by both Netlify Functions (netlify/functions/state.js) and local dev-server.js.
 * Enforces all authorization, concurrency, idempotency, and audit requirements (Section 18).
 */

const {
  verifyAdminRequest,
  authenticateStoreCredentials,
  verifyStoreActionRequest
} = require('./auth');
const {
  transactState,
  buildPublicStateView,
  parseGoogleSheetCSV
} = require('./storage');
const {
  BP_PER_POINT,
  pointsToBp,
  bpToPoints
} = require('./scoring');
const {
  generateId,
  processScheduledBoundaries,
  startDailyEvent,
  finalizeDailyClosing,
  initializeDailyEventForDate,
  performWeeklyRollover,
  enqueueSalesEntry,
  executeAttack,
  executeRevival,
  purchaseShield,
  announceCustomRound,
  resolveEliminationTie,
  reconcileSheetSnapshot,
  syncStoreDerivedTotals,
  syncWeeklyLedgerFromDailyEvent
} = require('./engine');

function extractSheetIds(urlOrId) {
  let sheetId = '1hJuUd6UkzfWBeTywVM6Yi5g0BxJodsNLe0XHgt-9nOQ';
  let gid = '1896995460';
  const matchId = String(urlOrId || '').match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (matchId) sheetId = matchId[1];
  const matchGid = String(urlOrId || '').match(/gid=([0-9]+)/);
  if (matchGid) gid = matchGid[1];
  return { sheetId, gid };
}

async function fetchSheetCsvFromGoogle(sheetUrl) {
  const { sheetId, gid } = extractSheetIds(sheetUrl);
  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  const res = await fetch(csvUrl, { signal: AbortSignal.timeout(12000), headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) {
    throw new Error(`Google Sheet HTTP ${res.status}`);
  }
  return await res.text();
}

/**
 * Handle an HTTP request ({ method, headers, body, options }) and return { statusCode, headers, bodyObj }.
 */
async function handleApiRequest({ method, headers = {}, body = {}, options = {} }) {
  const responseHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-pin, x-admin-token, x-store-token, x-store-id, x-store-access-code',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: responseHeaders, bodyObj: null };
  }

  const nowMs = options.nowMs || Date.now();

  if (method === 'GET') {
    const { result: publicView } = await transactState((state, txNowMs) => {
      processScheduledBoundaries(state, txNowMs);
      return buildPublicStateView(state, txNowMs);
    }, { ...options, nowMs });

    return {
      statusCode: 200,
      headers: responseHeaders,
      bodyObj: publicView
    };
  }

  if (method !== 'POST') {
    return {
      statusCode: 405,
      headers: responseHeaders,
      bodyObj: { error: 'Method Not Allowed' }
    };
  }

  const action = String(body.action || '').trim();

  try {
    // 1. Admin Authentication Check
    if (action === 'verify_pin' || action === 'verify_admin') {
      const auth = verifyAdminRequest(headers, body);
      if (!auth.authorized) {
        return {
          statusCode: auth.unconfigured ? 503 : 401,
          headers: responseHeaders,
          bodyObj: { ok: false, unconfigured: Boolean(auth.unconfigured), error: auth.error }
        };
      }
      return {
        statusCode: 200,
        headers: responseHeaders,
        bodyObj: { ok: true, adminToken: auth.token }
      };
    }

    // 2. Store Authentication Check
    if (action === 'authenticate_store') {
      const { result } = await transactState((state) => {
        return authenticateStoreCredentials(state, body.storeId, body.storeAccessCode);
      }, { ...options, nowMs });

      if (!result.authorized) {
        return {
          statusCode: result.unconfigured ? 503 : 401,
          headers: responseHeaders,
          bodyObj: { ok: false, unconfigured: Boolean(result.unconfigured), error: result.error }
        };
      }
      return {
        statusCode: 200,
        headers: responseHeaders,
        bodyObj: { ok: true, storeId: result.storeId, storeToken: result.token }
      };
    }

    // 3. Public / Scheduled Tick Trigger (Idempotent boundary advancement)
    if (action === 'scheduled_tick') {
      const { result: publicView } = await transactState((state, txNowMs) => {
        processScheduledBoundaries(state, txNowMs);
        return buildPublicStateView(state, txNowMs);
      }, { ...options, nowMs });
      return { statusCode: 200, headers: responseHeaders, bodyObj: publicView };
    }

    // 4. Store-Authorized Combat & Defense Actions
    if (action === 'store_attack' || action === 'store_revive' || action === 'store_purchase_shield') {
      const { result } = await transactState((state, txNowMs) => {
        const storeAuth = verifyStoreActionRequest(state, headers, body);
        if (!storeAuth.authorized) {
          const err = new Error(storeAuth.error);
          err.statusCode = 401;
          throw err;
        }

        const authenticatedStoreId = storeAuth.storeId;
        let actionResult;

        if (action === 'store_attack') {
          actionResult = executeAttack(state, {
            attackerId: authenticatedStoreId,
            targetId: String(body.targetId || '').trim().toUpperCase(),
            attackMode: String(body.attackMode || 'NORMAL').toUpperCase(),
            idempotencyKey: body.idempotencyKey || null,
            note: body.note || '',
            nowMs: txNowMs
          });
        } else if (action === 'store_revive') {
          actionResult = executeRevival(state, {
            storeId: authenticatedStoreId,
            idempotencyKey: body.idempotencyKey || null,
            note: body.note || '',
            nowMs: txNowMs
          });
        } else if (action === 'store_purchase_shield') {
          actionResult = purchaseShield(state, {
            storeId: authenticatedStoreId,
            idempotencyKey: body.idempotencyKey || null,
            nowMs: txNowMs
          });
        }

        return {
          actionResult,
          state: buildPublicStateView(state, txNowMs)
        };
      }, { ...options, nowMs });

      return {
        statusCode: 200,
        headers: responseHeaders,
        bodyObj: result.state
      };
    }

    // 5. All remaining actions require Admin Authorization
    const adminAuth = verifyAdminRequest(headers, body);
    if (!adminAuth.authorized) {
      return {
        statusCode: adminAuth.unconfigured ? 503 : 401,
        headers: responseHeaders,
        bodyObj: { error: adminAuth.error, unconfigured: Boolean(adminAuth.unconfigured) }
      };
    }

    // Optional pre-fetch of Google Sheet if admin_sync_sheet is requested without inline CSV/rows
    let fetchedSheetRows = null;
    if (action === 'admin_sync_sheet' && !Array.isArray(body.rows) && !body.csvText) {
      const targetUrl = body.sheetUrl || 'https://docs.google.com/spreadsheets/d/1hJuUd6UkzfWBeTywVM6Yi5g0BxJodsNLe0XHgt-9nOQ/edit?gid=1896995460';
      const csvText = await fetchSheetCsvFromGoogle(targetUrl);
      fetchedSheetRows = parseGoogleSheetCSV(csvText);
    }

    const { result: updatedPublicView } = await transactState((state, txNowMs) => {
      processScheduledBoundaries(state, txNowMs);

      switch (action) {
        case 'admin_start_event': {
          startDailyEvent(state, txNowMs, true);
          break;
        }

        case 'admin_stop_event': {
          if (body.confirm !== true) {
            throw new Error('Explicit confirmation (confirm: true) is required to stop/end a daily event.');
          }
          finalizeDailyClosing(state, txNowMs);
          state.auditLog.push({
            auditId: generateId('aud'),
            timestampMs: txNowMs,
            action: 'ADMIN_STOP_EVENT',
            details: { reason: body.reason || 'Manual Admin Stop' }
          });
          break;
        }

        case 'admin_pause_event': {
          if (state.currentEvent.status !== 'ACTIVE') {
            throw new Error('Only an ACTIVE event can be paused.');
          }
          state.currentEvent.status = 'PAUSED';
          state.currentEvent.pausedAtMs = txNowMs;
          state.currentEvent.pauseReason = body.reason || 'Paused by Admin (fixed Power phase and closing deadlines remain unchanged).';
          state.auditLog.push({
            auditId: generateId('aud'),
            timestampMs: txNowMs,
            action: 'ADMIN_PAUSE_EVENT',
            details: { reason: state.currentEvent.pauseReason }
          });
          break;
        }

        case 'admin_resume_event': {
          if (state.currentEvent.status !== 'PAUSED') {
            throw new Error('Event is not currently paused.');
          }
          state.currentEvent.status = 'ACTIVE';
          state.currentEvent.pausedAtMs = null;
          state.currentEvent.pauseReason = null;
          state.auditLog.push({
            auditId: generateId('aud'),
            timestampMs: txNowMs,
            action: 'ADMIN_RESUME_EVENT',
            details: {}
          });
          processScheduledBoundaries(state, txNowMs);
          break;
        }

        case 'admin_set_enabled_days': {
          if (body.enabledWeekdays && typeof body.enabledWeekdays === 'object') {
            for (const day of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
              if (body.enabledWeekdays[day] !== undefined) {
                state.enabledWeekdays[day] = Boolean(body.enabledWeekdays[day]);
              }
            }
          }
          if (body.enabledDateOverrides && typeof body.enabledDateOverrides === 'object') {
            state.enabledDateOverrides = {
              ...state.enabledDateOverrides,
              ...body.enabledDateOverrides
            };
          }
          syncWeeklyLedgerFromDailyEvent(state);
          state.auditLog.push({
            auditId: generateId('aud'),
            timestampMs: txNowMs,
            action: 'ADMIN_SET_ENABLED_DAYS',
            details: {
              enabledWeekdays: state.enabledWeekdays,
              enabledDateOverrides: state.enabledDateOverrides
            }
          });
          break;
        }

        case 'admin_switch_event_date': {
          const targetDateKey = String(body.dateKey || '').trim();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDateKey)) {
            throw new Error('Valid YYYY-MM-DD dateKey is required.');
          }
          initializeDailyEventForDate(state, targetDateKey, txNowMs);
          state.auditLog.push({
            auditId: generateId('aud'),
            timestampMs: txNowMs,
            action: 'ADMIN_INITIALIZE_EVENT_DATE',
            details: { targetDateKey }
          });
          break;
        }

        case 'admin_weekly_rollover': {
          performWeeklyRollover(state, txNowMs);
          break;
        }

        case 'admin_log_sale': {
          const storeId = String(body.storeId || '').trim().toUpperCase();
          const category = String(body.category || '').trim();
          const qty = body.qty !== undefined ? Number(body.qty) : 0;
          const accCents = body.accCents !== undefined ? Number(body.accCents) : undefined;
          const sourceTimestampMs = body.sourceTimestampMs !== undefined ? Number(body.sourceTimestampMs) : txNowMs;
          const note = String(body.note || '').trim();

          enqueueSalesEntry(state, {
            storeId,
            category,
            qty,
            accCents,
            sourceTimestampMs,
            ingestedAtMs: txNowMs,
            source: 'MANUAL',
            note
          });
          processScheduledBoundaries(state, txNowMs);
          break;
        }

        case 'admin_adjust_bonus': {
          const storeId = String(body.storeId || '').trim().toUpperCase();
          const store = state.stores[storeId];
          if (!store) throw new Error(`Unknown store: ${storeId}`);
          const deltaPoints = Number(body.points);
          if (!Number.isFinite(deltaPoints) || deltaPoints === 0) {
            throw new Error('Non-zero points adjustment required.');
          }
          const reason = String(body.reason || '').trim();
          if (!reason) {
            throw new Error('An audit reason is required for Admin point adjustments.');
          }
          const deltaBp = pointsToBp(deltaPoints);
          store.adminBonusBp += deltaBp;
          store.availableBp = Math.max(0, store.availableBp + deltaBp);
          syncStoreDerivedTotals(store);
          syncWeeklyLedgerFromDailyEvent(state);

          state.auditLog.push({
            auditId: generateId('aud'),
            timestampMs: txNowMs,
            action: 'ADMIN_ADJUST_BONUS',
            details: {
              storeId,
              deltaPoints,
              deltaBp,
              reason
            }
          });
          break;
        }

        case 'admin_correct_store_status': {
          const storeId = String(body.storeId || '').trim().toUpperCase();
          const store = state.stores[storeId];
          if (!store) throw new Error(`Unknown store: ${storeId}`);
          const reason = String(body.reason || '').trim();
          if (!reason) {
            throw new Error('An audit reason is required to correct a store status mistake.');
          }
          const prevStatus = store.status;
          const prevAvailBp = store.availableBp;

          if (body.status === 'STANDING' || body.status === 'KNOCKED_OUT') {
            store.status = body.status;
            if (body.status === 'STANDING') {
              store.eliminatedReason = null;
              store.eliminatedAtMs = null;
              store.eliminatedByStoreId = null;
            } else {
              store.eliminatedReason = 'ADMIN_AUDITED_CORRECTION';
              store.eliminatedAtMs = txNowMs;
            }
          }
          if (body.availablePoints !== undefined && body.availablePoints !== null && body.availablePoints !== '') {
            store.availableBp = Math.max(0, pointsToBp(body.availablePoints));
          }
          syncStoreDerivedTotals(store);

          state.auditLog.push({
            auditId: generateId('aud'),
            timestampMs: txNowMs,
            action: 'ADMIN_CORRECT_STORE_STATUS',
            details: {
              storeId,
              previousStatus: prevStatus,
              newStatus: store.status,
              previousAvailablePoints: bpToPoints(prevAvailBp),
              newAvailablePoints: bpToPoints(store.availableBp),
              reason
            }
          });
          break;
        }

        case 'admin_announce_round': {
          announceCustomRound(state, {
            startMs: Number(body.startMs),
            nowMs: txNowMs,
            adminNote: body.note || ''
          });
          break;
        }

        case 'admin_resolve_elimination_tie': {
          resolveEliminationTie(state, {
            eliminatedStoreId: String(body.eliminatedStoreId || '').trim().toUpperCase(),
            adminNote: body.note || '',
            nowMs: txNowMs
          });
          break;
        }

        case 'admin_resolve_weekly_tie': {
          const winnerStoreId = body.winnerStoreId ? String(body.winnerStoreId).trim().toUpperCase() : null;
          const isSharedResult = Boolean(body.isSharedResult);
          const sharedStoreIds = Array.isArray(body.sharedStoreIds) ? body.sharedStoreIds : [];
          const reason = String(body.reason || '').trim();
          if (!reason) {
            throw new Error('A sales-based reason or admin review note is required to resolve a weekly tie.');
          }
          state.currentWeek.weeklyTieResolution = {
            resolvedAtMs: txNowMs,
            winnerStoreId: isSharedResult ? null : winnerStoreId,
            isSharedResult,
            sharedStoreIds,
            reason
          };
          state.auditLog.push({
            auditId: generateId('aud'),
            timestampMs: txNowMs,
            action: 'ADMIN_RESOLVE_WEEKLY_TIE',
            details: state.currentWeek.weeklyTieResolution
          });
          break;
        }

        case 'admin_resolve_reconciliation_issue': {
          const issueId = String(body.issueId || '').trim();
          const resolution = String(body.resolution || '').trim(); // 'APPLY' | 'DISMISS'
          const issue = state.reconciliationIssues.find(i => i.issueId === issueId && !i.resolved);
          if (!issue) throw new Error('Reconciliation issue not found or already resolved.');

          if (issue.type === 'DOWNWARD_CORRECTION') {
            const store = state.stores[issue.storeId];
            if (store && resolution === 'APPLY') {
              const prev = issue.details.previous;
              const inc = issue.details.incoming;
              store.sheetBaseline.vl = inc.vl;
              store.sheetBaseline.bts = inc.bts;
              store.sheetBaseline.hsi = inc.hsi;
              store.sheetBaseline.accCents = inc.accCents;

              const vlDiff = inc.vl - prev.vl;
              const btsDiff = inc.bts - prev.bts;
              const hsiDiff = inc.hsi - prev.hsi;
              const accDiff = inc.accCents - prev.accCents;

              const prevSalesEarnedBp = store.salesEarnedBp;
              store.quantities.totalVl = Math.max(0, store.quantities.totalVl + vlDiff);
              store.quantities.watches = Math.max(0, store.quantities.watches + btsDiff);
              store.quantities.hsi = Math.max(0, store.quantities.hsi + hsiDiff);
              store.quantities.accCents = Math.max(0, store.quantities.accCents + accDiff);

              syncStoreDerivedTotals(store);
              const bpDiff = store.salesEarnedBp - prevSalesEarnedBp;
              store.availableBp = Math.max(0, store.availableBp + bpDiff);
              syncWeeklyLedgerFromDailyEvent(state);
            } else if (store && resolution === 'DISMISS') {
              // Keep baseline at incoming so it doesn't re-alert, without deducting points
              const inc = issue.details.incoming;
              store.sheetBaseline.vl = inc.vl;
              store.sheetBaseline.bts = inc.bts;
              store.sheetBaseline.hsi = inc.hsi;
              store.sheetBaseline.accCents = inc.accCents;
            }
          } else if (issue.type === 'LATE_CROSS_BOUNDARY_SALE') {
            if (resolution === 'APPLY_CURRENT') {
              enqueueSalesEntry(state, {
                storeId: issue.storeId,
                category: issue.category,
                qty: issue.qty,
                accCents: issue.accCents,
                sourceTimestampMs: state.currentEvent.scheduledStartMs,
                ingestedAtMs: txNowMs,
                source: 'ADMIN_ATTRIBUTED_LATE_SALE',
                note: `Attributed late sale: ${issue.note || ''}`
              });
              processScheduledBoundaries(state, txNowMs);
            }
          }

          issue.resolved = true;
          issue.resolvedAtMs = txNowMs;
          issue.resolution = resolution;
          state.auditLog.push({
            auditId: generateId('aud'),
            timestampMs: txNowMs,
            action: 'ADMIN_RESOLVE_RECONCILIATION_ISSUE',
            details: { issueId, type: issue.type, resolution }
          });
          break;
        }

        case 'admin_set_store_access_codes': {
          const codes = body.storeAccessCodes;
          if (!codes || typeof codes !== 'object') {
            throw new Error('storeAccessCodes object required.');
          }
          if (!state.storeAccessCodes) state.storeAccessCodes = {};
          const updatedIds = [];
          for (const [id, code] of Object.entries(codes)) {
            const cleanId = String(id).trim().toUpperCase();
            const cleanCode = String(code || '').trim();
            if (cleanId && cleanCode) {
              state.storeAccessCodes[cleanId] = cleanCode;
              updatedIds.push(cleanId);
            }
          }
          state.auditLog.push({
            auditId: generateId('aud'),
            timestampMs: txNowMs,
            action: 'ADMIN_PROVISION_STORE_ACCESS_CODES',
            details: { updatedStoreIds: updatedIds }
          });
          break;
        }

        case 'admin_sync_sheet': {
          const rows = Array.isArray(body.rows)
            ? body.rows
            : body.csvText
            ? parseGoogleSheetCSV(body.csvText)
            : fetchedSheetRows || [];
          reconcileSheetSnapshot(state, rows, txNowMs, body.reportDateKey);
          break;
        }

        case 'admin_set_announcement': {
          const text = String(body.text || '').trim();
          state.announcement = {
            text,
            active: Boolean(text && body.active !== false),
            updatedAt: new Date(txNowMs).toISOString()
          };
          break;
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      return buildPublicStateView(state, txNowMs);
    }, { ...options, nowMs });

    return {
      statusCode: 200,
      headers: responseHeaders,
      bodyObj: updatedPublicView
    };
  } catch (err) {
    return {
      statusCode: err.statusCode || 400,
      headers: responseHeaders,
      bodyObj: { error: err.message || 'Request failed' }
    };
  }
}

module.exports = {
  handleApiRequest,
  fetchSheetCsvFromGoogle
};
