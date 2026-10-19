'use strict';
const { verifyAdminRequest } = require('./auth');
const { transactState, readRawStateFromStorage, writeStateBackup, buildPublicStateView } = require('./storage');
const engine = require('./engine');
const { getEasternParts, getDailyScheduleForDateKey } = require('./time');

function replaceState(state, next) {
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, next);
}
function seedSandbox(state, scenario, realNow) {
  const schedule = getDailyScheduleForDateKey(getEasternParts(realNow).dateKey);
  const next = engine.createInitialDatabaseState(schedule.scheduledStartMs);
  next.sheetImportsPaused = true;
  next.gameZone = 'sandbox';
  next.sandboxClockMs = schedule.scheduledStartMs;
  for (const [i, store] of Object.values(next.stores).entries()) {
    store.adminBonusBp = (5000 + i * 500) * 100;
    store.availableBp = store.adminBonusBp;
    store.deflection.survivedAttacksInFirst120 = scenario === 'deflection' ? 2 : 0;
    store.deflection.qualifiedForDay = scenario === 'deflection';
    engine.syncStoreDerivedTotals(store);
  }
  engine.startDailyEvent(next, schedule.scheduledStartMs, true);
  next.sandboxClockMs = scenario === 'power' ? schedule.powerPhaseStartMs :
    schedule.scheduledStartMs + (scenario === 'deflection' ? 130 : scenario === 'battle' ? 10 : 0) * 60000;
  engine.processScheduledBoundaries(next, next.sandboxClockMs);
  replaceState(state, next);
}
const RESET_PHRASES = { admin_reset_combat: 'RESET COMBAT', admin_new_tournament: 'NEW TOURNAMENT', admin_clear_database: 'CLEAR DATABASE' };
async function routeAdminRequest(request, core) {
  const { method, body = {}, headers = {} } = request;
  const action = String(body.action || '');
  const sandbox = Object.entries(headers).some(([k,v]) => k.toLowerCase() === 'x-game-zone' && v === 'sandbox');
  const auth = verifyAdminRequest(headers, body);
  const special = action in RESET_PHRASES || ['admin_export_backup','admin_resume_imports','admin_test_seed','admin_test_advance','admin_test_combat'].includes(action);
  const response = (statusCode, bodyObj) => ({ statusCode, headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store', 'Access-Control-Allow-Origin':'*' }, bodyObj });
  if (method === 'OPTIONS') return core(request);
  if ((sandbox || special) && !auth.authorized) return response(401, { error:'Admin authentication required.' });
  if (auth.authorized && (action.startsWith('store_') || action === 'authenticate_store')) return response(403, { error:'Admin sessions are neutral. Use Test Zone to simulate store actions.' });
  if (action.startsWith('admin_test_') && !sandbox) return response(400, { error:'Test actions require the isolated Test Zone.' });
  if (sandbox && action === 'admin_sync_sheet') return response(400, { error:'Google Sheet imports are disabled in Test Zone. Use sample sales.' });
  const options = { ...request.options, zone: sandbox ? 'sandbox' : 'live' };
  try {
    if (sandbox) {
      const saved = await readRawStateFromStorage(options);
      if (!saved.state.sandboxClockMs) {
        const { result: clock } = await transactState(state => {
          if (!state.sandboxClockMs) seedSandbox(state, 'opening', options.nowMs || Date.now());
          return state.sandboxClockMs;
        }, options);
        options.nowMs = clock;
      } else options.nowMs = saved.state.sandboxClockMs;
    }
    if (!special) return await core({ ...request, options });
    if (method !== 'POST') return response(405, { error:'POST required.' });
    const { result } = await transactState(async (state, nowMs) => {
      if (action === 'admin_export_backup') {
        const backupId = await writeStateBackup(state, options);
        return { backupId, snapshot: JSON.parse(JSON.stringify(state)) };
      }
      if (RESET_PHRASES[action]) {
        if (body.confirmation !== RESET_PHRASES[action]) throw new Error(`Type ${RESET_PHRASES[action]} to confirm.`);
        const backupId = await writeStateBackup(state, options);
        if (action === 'admin_reset_combat') {
          for (const store of Object.values(state.stores)) {
            const clean = engine.createStoreDailyState(store);
            for (const key of ['status','eliminatedReason','eliminatedAtMs','eliminatedByStoreId','attackSpentBp','revivalSpentBp','shieldSpentBp','incomingDamageBp','deflection','shield','kosDealtToday','timesKnockedOutToday','timesRevivedToday','attacksSurvivedToday']) store[key] = clean[key];
            store.availableBp = store.totalEarnedBp;
          }
          state.combatLog = [];
          // Restart round allowances without replaying already processed schedule boundaries.
          for (const round of Object.values(state.currentEvent.roundStates || {})) {
            round.attacksByStore = {}; round.deflectedHits = {}; round.deflectionSnapshot = {}; round.shieldActiveStores = {};
          }
          state.processedIdempotencyKeys = {};
        } else {
          const next = engine.createInitialDatabaseState(nowMs);
          next.storeAccessCodes = state.storeAccessCodes;
          next.enabledWeekdays = state.enabledWeekdays;
          next.enabledDateOverrides = state.enabledDateOverrides;
          next.sheetImportsPaused = true;
          next.tournamentId = engine.generateId('tournament');
          if (action === 'admin_new_tournament') next.weeklyArchives = [...state.weeklyArchives, state.currentWeek];
          if (sandbox) { next.gameZone = 'sandbox'; next.sandboxClockMs = nowMs; }
          replaceState(state, next);
        }
        state.lastAdminBackupId = backupId;
        state.auditLog.push({ action:action.toUpperCase(), timestampMs:nowMs, details:{ backupId } });
      } else if (action === 'admin_resume_imports') {
        if (sandbox) throw new Error('Sheet imports are unavailable in Test Zone.');
        state.sheetImportsPaused = false;
        state.auditLog.push({ action:'ADMIN_RESUME_IMPORTS', timestampMs:nowMs, details:{} });
      } else if (action === 'admin_test_seed') {
        if (!['opening','battle','deflection','power'].includes(body.scenario)) throw new Error('Unknown test scenario.');
        seedSandbox(state, body.scenario, Date.now());
      } else if (action === 'admin_test_advance') {
        if (![1,5,20,60].includes(Number(body.minutes))) throw new Error('Choose 1, 5, 20, or 60 minutes.');
        state.sandboxClockMs += Number(body.minutes) * 60000;
      } else if (action === 'admin_test_combat') {
        const params = { storeId:body.actorId, attackerId:body.actorId, targetId:body.targetId, attackMode:body.attackMode || 'NORMAL', nowMs:state.sandboxClockMs, idempotencyKey:body.idempotencyKey };
        const fn = { attack:engine.executeAttack, revive:engine.executeRevival, shield:engine.purchaseShield }[body.kind];
        if (!fn) throw new Error('Unknown test action.');
        fn(state, params);
      }
      return buildPublicStateView(state, sandbox ? state.sandboxClockMs : nowMs);
    }, options);
    return response(200, result);
  } catch (error) {
    if (/Persistent database|context|blob/i.test(error.message)) throw error;
    if (!special && !sandbox) throw error;
    return response(error.statusCode || 400, { error:error.message });
  }
}
module.exports = { routeAdminRequest };
