/**
 * Knockout Blitz — Authoritative Server Game Engine
 * Implements Sections 1–19 of the Knockout Blitz Specification.
 */

const crypto = require('crypto');
const {
  getEasternParts,
  getWeeklyPeriodForTimestamp,
  getDailyScheduleForDateKey,
  formatEasternTimeLabel,
  formatEasternDateTime
} = require('./time');
const {
  BP_PER_POINT,
  POINTS_CONFIG,
  parseDollarsToCents,
  formatCentsToDollars,
  pointsToBp,
  bpToPoints,
  formatBp,
  calculateSalesPointsBp
} = require('./scoring');

const OFFICIAL_ROSTER = [
  { id: '843D', name: '843D — El Cartel', shortName: 'El Cartel', emoji: '🎩' },
  { id: '693D', name: '693D — Spartans', shortName: 'Spartans', emoji: '⚔️' },
  { id: '561D', name: '561D — Top Guns', shortName: 'Top Guns', emoji: '✈️' },
  { id: '5383', name: '5383 — Pink Panthers', shortName: 'Pink Panthers', emoji: '🐾' },
  { id: '769D', name: '769D — Pink Mafia', shortName: 'Pink Mafia', emoji: '🕶️' },
  { id: '5733', name: '5733 — Undefeated', shortName: 'Undefeated', emoji: '👑' },
  { id: '582D', name: '582D — Magenta Warriors', shortName: 'Magenta Warriors', emoji: '🛡️' },
  { id: '892E', name: '892E — Avengers', shortName: 'Avengers', emoji: '⚡' },
  { id: '697D', name: '697D — Wolfpack', shortName: 'Wolfpack', emoji: '🐺' }
];

const SCHEMA_VERSION = 2;

function generateId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Create a fresh per-store daily ledger state.
 */
function createStoreDailyState(storeMeta, carriedOpeningBalanceBp = 0) {
  return {
    id: storeMeta.id,
    name: storeMeta.name,
    shortName: storeMeta.shortName,
    emoji: storeMeta.emoji,
    status: 'STANDING', // 'STANDING' | 'KNOCKED_OUT'
    eliminatedReason: null,
    eliminatedAtMs: null,
    eliminatedByStoreId: null,

    // Point Ledger (in exact integer Basis Points: 1 pt = 100 bp)
    carriedOpeningBalanceBp: Number(carriedOpeningBalanceBp || 0),
    baseSalesEarnedBp: 0,
    salesMilestoneBonusBp: 0,
    salesMilestoneCount: 0,
    salesEarnedBp: 0, // baseSalesEarnedBp + salesMilestoneBonusBp (+300 per 300 base sales pts)
    adminBonusBp: 0,
    totalEarnedBp: Number(carriedOpeningBalanceBp || 0), // carried + daily salesEarned + daily adminBonus
    dailyEarnedBp: 0, // newly earned today: salesEarnedBp + adminBonusBp
    attackSpentBp: 0,
    revivalSpentBp: 0,
    shieldSpentBp: 0,
    incomingDamageBp: 0, // effective damage deducted from availableBp
    availableBp: Number(carriedOpeningBalanceBp || 0),
    pendingBp: 0,

    // Quantities (Released / Eligible today)
    quantities: {
      totalVl: 0,
      watches: 0,
      tablets: 0,
      bts: 0,
      hsi: 0,
      accCents: 0
    },

    // Pending quantities awaiting next cutoff (:07, :27, :47)
    pendingQuantities: {
      totalVl: 0,
      watches: 0,
      tablets: 0,
      bts: 0,
      hsi: 0,
      accCents: 0
    },

    // Non-scoring informational metrics from Google Sheet
    sheetInfo: {
      nrGoal: 0,
      netRev: 0,
      accGoal: 0,
      postGoal: 0,
      totalPP: 0,
      visa: 0,
      preOrders: 0
    },

    // Sheet reconciliation baseline for current daily event
    sheetBaseline: {
      initialized: false,
      vl: 0,
      bts: 0,
      hsi: 0,
      accCents: 0
    },

    // Deflection tracking (Section 11)
    deflection: {
      survivedAttacksInFirst120: 0,
      qualifiedForDay: false,
      activeForRoundId: null,
      brokenInRoundId: null
    },

    // Shield tracking (Section 13 — Power Phase only)
    shield: {
      queuedForRoundId: null,
      purchasedAtMs: null,
      activeRoundId: null,
      protectedUntilMs: null,
      lastExpiredRoundId: null
    },

    // Daily stats
    kosDealtToday: 0,
    timesKnockedOutToday: 0,
    timesRevivedToday: 0,
    attacksSurvivedToday: 0
  };
}

/**
 * Create the authoritative initial database state (Schema v2).
 */
function createInitialDatabaseState(nowMs = Date.now()) {
  const weeklyPeriod = getWeeklyPeriodForTimestamp(nowMs);
  const parts = getEasternParts(nowMs);
  const schedule = getDailyScheduleForDateKey(parts.dateKey);

  const stores = {};
  const weeklyStoreLedger = {};
  for (const meta of OFFICIAL_ROSTER) {
    stores[meta.id] = createStoreDailyState(meta, 0);
    weeklyStoreLedger[meta.id] = {
      storeId: meta.id,
      name: meta.name,
      cumulativeEarnedBp: 0,
      cumulativeSalesEarnedBp: 0,
      cumulativeAdminBonusBp: 0,
      dailyBreakdown: {}, // { [dateKey]: { salesEarnedBp, adminBonusBp, totalDailyEarnedBp, qualified: boolean } }
      qualifierCount: 0
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    updatedAt: new Date(nowMs).toISOString(),
    branding: 'Knockout Blitz',
    districtName: 'PHOENIX DISTRICT',
    timezone: 'America/New_York',

    // Enabled event days of week (Admin configurable)
    enabledWeekdays: {
      Sun: true,
      Mon: true,
      Tue: true,
      Wed: true,
      Thu: true,
      Fri: true,
      Sat: true
    },
    // Optional date-specific enable/disable overrides { 'YYYY-MM-DD': true | false }
    enabledDateOverrides: {},

    // Current Weekly Competition Period [startMs, nextStartMs)
    currentWeek: {
      ...weeklyPeriod,
      countedDaysHeld: [], // array of YYYY-MM-DD dateKeys actually held this week
      dailyQualifiersByDate: {}, // { [dateKey]: ['843D', ...] }
      weeklyStoreLedger,
      weeklyTieResolution: null // { resolvedAtMs, winnerStoreId, isSharedResult, reason, adminNote }
    },

    // Historical archived weeks
    weeklyArchives: [],

    // Current Daily Event State
    currentEvent: {
      eventId: `evt_${parts.dateKey}`,
      dateKey: parts.dateKey,
      weekId: weeklyPeriod.weekId,
      weekdayShort: schedule.weekdayShort,
      isSunday: schedule.isSunday,
      status: 'SCHEDULED', // 'SCHEDULED' | 'ACTIVE' | 'PAUSED' | 'AWAITING_TIE_RESOLUTION' | 'ENDED_NORMAL' | 'ENDED_DRAW'
      phase: 'PRE_EVENT', // 'PRE_EVENT' | 'REGULAR_HOURS' | 'FINAL_STRETCH' | 'POWER_PHASE' | 'CLOSED'
      scheduledStartMs: schedule.scheduledStartMs,
      actualStartMs: null,
      scheduledCloseMs: schedule.eventCloseMs,
      actualCloseMs: null,
      pausedAtMs: null,
      pauseReason: null,
      deflectionUnlockMs: schedule.deflectionUnlockMs,
      finalStretchStartMs: schedule.finalStretchStartMs,
      powerPhaseStartMs: schedule.powerPhaseStartMs,
      powerPhaseEntryChecked: false,
      drawReason: null,
      drawBalancesSnapshot: null,
      dailyQualifiers: [],
      customRounds: [],
      activeRoundId: null,
      // Per-round runtime tracking: { [roundId]: { roundId, status, startedAtMs, closedAtMs, attacksByStore: { [storeId]: count }, deflectedHits: { [attackerId]: { [targetId]: true } }, deflectionSnapshot: { [storeId]: boolean }, shieldActiveStores: { [storeId]: protectedUntilMs } } }
      roundStates: {},
      processedCutoffs: {}, // { [cutoffKey]: timestampMs }
      processedCheckpoints: {}, // { [checkpointId]: { processedAtMs, eliminatedStoreId, status } }
      pendingEliminationTie: null // { checkpointId, checkpointLabel, timestampMs, candidateStoreIds, candidateSnapshots }
    },

    // Current Day Store States
    stores,

    // Pending sales awaiting next scheduled 3-minute cutoff (:07, :27, :47)
    // [ { saleId, storeId, category, qty, accCents, pointsBp, effectiveTimestampMs, sourceTimestampMs, ingestedAtMs, source, note, status: 'PENDING' | 'RELEASED' } ]
    pendingSalesQueue: [],

    // Unreconciled manual entries (for matching against subsequent Google Sheet increments to prevent double credit)
    // [ { entryId, storeId, category, qty, accCents, createdAtMs, note, reconciledQty } ]
    unreconciledManualEntries: [],

    // Reconciliation issues & late cross-boundary sales requiring explicit Admin attribution
    // [ { issueId, type: 'DOWNWARD_CORRECTION' | 'LATE_CROSS_BOUNDARY_SALE' | 'UNMATCHED_BEYOND', storeId, details, createdAtMs, resolved: false } ]
    reconciliationIssues: [],

    // Sheet import metadata
    sheetSyncMeta: {
      sheetUrl: 'https://docs.google.com/spreadsheets/d/1hJuUd6UkzfWBeTywVM6Yi5g0BxJodsNLe0XHgt-9nOQ/edit?gid=1896995460',
      lastAttemptAtMs: null,
      lastSuccessAtMs: null,
      lastContentHash: null,
      importCount: 0,
      lastError: null
    },

    // Broadcast announcement
    announcement: {
      text: '',
      active: false,
      updatedAt: null
    },

    // Store authentication codes (Admin can provision/rotate; never exposed to public GET /api/state)
    storeAccessCodes: {},

    // Combat, Revival, Shield, Elimination & Audit Logs
    combatLog: [],
    salesLog: [],
    auditLog: [],
    dailyArchives: [],

    // Idempotency key registry { [idempotencyKey]: { processedAtMs, action, resultSummary } }
    processedIdempotencyKeys: {},

    // Migration backup & flagged legacy records
    migrationMeta: {
      migratedFromV1At: null,
      flaggedLegacyRecords: [],
      legacyBackup: null
    }
  };
}

/**
 * Check if a given dateKey is enabled for competition.
 */
function isEventDayEnabled(state, dateKey) {
  if (state.enabledDateOverrides && state.enabledDateOverrides[dateKey] !== undefined) {
    return Boolean(state.enabledDateOverrides[dateKey]);
  }
  const noonMs = getDailyScheduleForDateKey(dateKey).scheduledStartMs;
  const parts = getEasternParts(noonMs);
  return Boolean(state.enabledWeekdays?.[parts.weekdayShort] ?? true);
}

/**
 * Recompute a store's totalEarnedBp and dailyEarnedBp from its ledger components.
 */
function syncStoreDerivedTotals(store) {
  store.quantities.bts = store.quantities.watches + store.quantities.tablets;
  store.pendingQuantities.bts = store.pendingQuantities.watches + store.pendingQuantities.tablets;

  const releasedCalc = calculateSalesPointsBp({
    totalVl: store.quantities.totalVl,
    bts: store.quantities.bts,
    hsi: store.quantities.hsi,
    accCents: store.quantities.accCents
  });

  const combinedCalc = calculateSalesPointsBp({
    totalVl: store.quantities.totalVl + store.pendingQuantities.totalVl,
    bts: store.quantities.bts + store.pendingQuantities.bts,
    hsi: store.quantities.hsi + store.pendingQuantities.hsi,
    accCents: store.quantities.accCents + store.pendingQuantities.accCents
  });

  store.baseSalesEarnedBp = releasedCalc.baseSalesBp;
  store.salesMilestoneBonusBp = releasedCalc.milestoneBonusBp;
  store.salesMilestoneCount = releasedCalc.milestoneCount;
  store.salesEarnedBp = releasedCalc.totalSalesBp;
  store.pendingBp = Math.max(0, combinedCalc.totalSalesBp - releasedCalc.totalSalesBp);

  store.dailyEarnedBp = store.salesEarnedBp + store.adminBonusBp;
  store.totalEarnedBp = store.carriedOpeningBalanceBp + store.dailyEarnedBp;
}

/**
 * Sync today's store earnings into the current week's cumulative ledger.
 */
function syncWeeklyLedgerFromDailyEvent(state) {
  const evt = state.currentEvent;
  if (!evt || !state.currentWeek || evt.weekId !== state.currentWeek.weekId) return;
  const dateKey = evt.dateKey;
  const isHeld =
    evt.actualStartMs !== null ||
    evt.status === 'ACTIVE' ||
    evt.status === 'PAUSED' ||
    evt.status === 'AWAITING_TIE_RESOLUTION' ||
    evt.status === 'ENDED_NORMAL' ||
    evt.status === 'ENDED_DRAW';

  if (isHeld && isEventDayEnabled(state, dateKey)) {
    if (!state.currentWeek.countedDaysHeld.includes(dateKey)) {
      state.currentWeek.countedDaysHeld.push(dateKey);
      state.currentWeek.countedDaysHeld.sort();
    }
  }

  for (const storeId of Object.keys(state.stores)) {
    const st = state.stores[storeId];
    syncStoreDerivedTotals(st);
    const wkStore = state.currentWeek.weeklyStoreLedger[storeId];
    if (!wkStore) continue;

    if (isHeld) {
      wkStore.dailyBreakdown[dateKey] = {
        salesEarnedBp: st.salesEarnedBp,
        adminBonusBp: st.adminBonusBp,
        totalDailyEarnedBp: st.dailyEarnedBp,
        qualified: evt.dailyQualifiers.includes(storeId)
      };
    }

    // Recompute weekly totals across all counted days in dailyBreakdown
    let sumSalesBp = 0;
    let sumBonusBp = 0;
    for (const dKey of Object.keys(wkStore.dailyBreakdown)) {
      if (isEventDayEnabled(state, dKey)) {
        sumSalesBp += Number(wkStore.dailyBreakdown[dKey].salesEarnedBp || 0);
        sumBonusBp += Number(wkStore.dailyBreakdown[dKey].adminBonusBp || 0);
      }
    }
    wkStore.cumulativeSalesEarnedBp = sumSalesBp;
    wkStore.cumulativeAdminBonusBp = sumBonusBp;
    wkStore.cumulativeEarnedBp = sumSalesBp + sumBonusBp;

    // Count qualifiers across week
    let qCount = 0;
    for (const qList of Object.values(state.currentWeek.dailyQualifiersByDate || {})) {
      if (Array.isArray(qList) && qList.includes(storeId)) qCount++;
    }
    wkStore.qualifierCount = qCount;
  }
}

/**
 * Compute Weekly Rankings & Averages (Sections 2 & 5):
 * 1. Highest cumulative earned points for the week.
 * 2. Highest average daily earned points (newly earned points / counted enabled event days held).
 * 3. Admin decision based on sales.
 * 4. Shared result only as a last resort after admin review.
 * Never ranks by daily wins or knockout count.
 */
function getWeeklyStandings(state) {
  syncWeeklyLedgerFromDailyEvent(state);
  const countedDays = (state.currentWeek?.countedDaysHeld || []).filter(d => isEventDayEnabled(state, d));
  const denominator = countedDays.length;
  const resolution = state.currentWeek?.weeklyTieResolution || null;

  const entries = OFFICIAL_ROSTER.map(meta => {
    const wk = state.currentWeek?.weeklyStoreLedger?.[meta.id] || {
      cumulativeEarnedBp: 0,
      cumulativeSalesEarnedBp: 0,
      cumulativeAdminBonusBp: 0,
      dailyBreakdown: {},
      qualifierCount: 0
    };
    const avgDailyBp = denominator > 0 ? Math.round(wk.cumulativeEarnedBp / denominator) : 0;
    const exactAvgPoints = denominator > 0 ? bpToPoints(wk.cumulativeEarnedBp) / denominator : 0;

    return {
      storeId: meta.id,
      name: meta.name,
      emoji: meta.emoji,
      cumulativeEarnedBp: wk.cumulativeEarnedBp,
      cumulativeEarnedPoints: bpToPoints(wk.cumulativeEarnedBp),
      cumulativeSalesEarnedBp: wk.cumulativeSalesEarnedBp,
      cumulativeSalesEarnedPoints: bpToPoints(wk.cumulativeSalesEarnedBp),
      cumulativeAdminBonusBp: wk.cumulativeAdminBonusBp,
      countedDaysHeld: denominator,
      averageDailyEarnedBp: avgDailyBp,
      averageDailyEarnedPoints: Number(exactAvgPoints.toFixed(2)),
      qualifierCount: wk.qualifierCount,
      dailyBreakdown: wk.dailyBreakdown,
      isAdminSelectedWinner: Boolean(resolution && resolution.winnerStoreId === meta.id),
      isSharedResultWinner: Boolean(
        resolution &&
          resolution.isSharedResult &&
          Array.isArray(resolution.sharedStoreIds) &&
          resolution.sharedStoreIds.includes(meta.id)
      )
    };
  });

  entries.sort((a, b) => {
    if (b.cumulativeEarnedBp !== a.cumulativeEarnedBp) {
      return b.cumulativeEarnedBp - a.cumulativeEarnedBp;
    }
    if (b.averageDailyEarnedPoints !== a.averageDailyEarnedPoints) {
      return b.averageDailyEarnedPoints - a.averageDailyEarnedPoints;
    }
    if (a.isAdminSelectedWinner !== b.isAdminSelectedWinner) {
      return a.isAdminSelectedWinner ? -1 : 1;
    }
    return a.storeId.localeCompare(b.storeId);
  });

  // Detect if top stores are tied on both cumulativeEarnedBp and averageDailyEarnedPoints
  let hasUnresolvedFirstPlaceTie = false;
  let tiedTopStoreIds = [];
  if (entries.length >= 2 && entries[0].cumulativeEarnedBp > 0) {
    const top = entries[0];
    tiedTopStoreIds = entries
      .filter(
        e =>
          e.cumulativeEarnedBp === top.cumulativeEarnedBp &&
          e.averageDailyEarnedPoints === top.averageDailyEarnedPoints
      )
      .map(e => e.storeId);
    if (tiedTopStoreIds.length > 1 && !resolution) {
      hasUnresolvedFirstPlaceTie = true;
    }
  }

  return {
    weekId: state.currentWeek?.weekId,
    startIso: state.currentWeek?.startIso,
    nextStartIso: state.currentWeek?.nextStartIso,
    countedDaysHeld: countedDays,
    countedDaysCount: denominator,
    hasUnresolvedFirstPlaceTie,
    tiedTopStoreIds,
    weeklyTieResolution: resolution,
    standings: entries
  };
}

/**
 * Initialize or transition to a new Daily Event on `targetDateKey` within the current week
 * (Section 6: Daily Carryover).
 * - Restores every store to STANDING.
 * - Starts each store with its cumulative carried earned-point balance for the week.
 * - Prior daily spending and incoming damage do NOT reduce the new opening balance.
 * - Resets daily combat state, attack allowances, shields, and deflection qualification.
 * - Preserves archived daily records and qualifier results.
 * - Does not double-count carried points as new earnings.
 */
function initializeDailyEventForDate(state, targetDateKey, nowMs = Date.now()) {
  // Archive previous daily event if it was active or ended and not yet archived
  if (state.currentEvent && state.currentEvent.dateKey !== targetDateKey) {
    syncWeeklyLedgerFromDailyEvent(state);
    const alreadyArchived = state.dailyArchives.some(a => a.eventId === state.currentEvent.eventId);
    if (!alreadyArchived && state.currentEvent.actualStartMs !== null) {
      state.dailyArchives.push({
        ...JSON.parse(JSON.stringify(state.currentEvent)),
        archivedAtMs: nowMs,
        finalStoresSnapshot: JSON.parse(JSON.stringify(state.stores))
      });
    }
  }

  const schedule = getDailyScheduleForDateKey(targetDateKey);
  const weekPeriod = getWeeklyPeriodForTimestamp(schedule.scheduledStartMs);

  // Ensure we are in the right week; if week rolled over, perform weekly rollover first
  if (state.currentWeek && state.currentWeek.weekId !== weekPeriod.weekId) {
    performWeeklyRollover(state, schedule.scheduledStartMs);
  }

  const newStores = {};
  for (const meta of OFFICIAL_ROSTER) {
    const wkLedger = state.currentWeek?.weeklyStoreLedger?.[meta.id];
    // Carried balance = sum of earned points from prior days in this week (excluding targetDateKey)
    let carriedBp = 0;
    if (wkLedger && wkLedger.dailyBreakdown) {
      for (const [dKey, dayRec] of Object.entries(wkLedger.dailyBreakdown)) {
        if (dKey < targetDateKey && isEventDayEnabled(state, dKey)) {
          carriedBp += Number(dayRec.totalDailyEarnedBp || 0);
        }
      }
    }
    newStores[meta.id] = createStoreDailyState(meta, carriedBp);
  }

  state.stores = newStores;
  state.pendingSalesQueue = [];
  state.unreconciledManualEntries = [];

  state.currentEvent = {
    eventId: `evt_${targetDateKey}`,
    dateKey: targetDateKey,
    weekId: state.currentWeek.weekId,
    weekdayShort: schedule.weekdayShort,
    isSunday: schedule.isSunday,
    status: 'SCHEDULED',
    phase: 'PRE_EVENT',
    scheduledStartMs: schedule.scheduledStartMs,
    actualStartMs: null,
    scheduledCloseMs: schedule.eventCloseMs,
    actualCloseMs: null,
    pausedAtMs: null,
    pauseReason: null,
    deflectionUnlockMs: schedule.deflectionUnlockMs,
    finalStretchStartMs: schedule.finalStretchStartMs,
    powerPhaseStartMs: schedule.powerPhaseStartMs,
    powerPhaseEntryChecked: false,
    drawReason: null,
    drawBalancesSnapshot: null,
    dailyQualifiers: [],
    customRounds: [],
    activeRoundId: null,
    roundStates: {},
    processedCutoffs: {},
    processedCheckpoints: {},
    pendingEliminationTie: null
  };

  return state;
}

/**
 * Perform idempotent Sunday 7:00 PM Eastern Weekly Rollover (Section 6).
 */
function performWeeklyRollover(state, nowMs = Date.now()) {
  const targetWeek = getWeeklyPeriodForTimestamp(nowMs);
  if (state.currentWeek && state.currentWeek.weekId === targetWeek.weekId) {
    return { rolledOver: false, weekId: targetWeek.weekId };
  }

  syncWeeklyLedgerFromDailyEvent(state);
  const completedStandings = getWeeklyStandings(state);

  // Archive current week idempotently
  if (state.currentWeek && !state.weeklyArchives.some(w => w.weekId === state.currentWeek.weekId)) {
    state.weeklyArchives.push({
      ...JSON.parse(JSON.stringify(state.currentWeek)),
      finalStandings: completedStandings.standings,
      archivedAtMs: nowMs
    });
  }

  // Archive current daily event if not archived
  if (
    state.currentEvent &&
    state.currentEvent.actualStartMs !== null &&
    !state.dailyArchives.some(a => a.eventId === state.currentEvent.eventId)
  ) {
    state.dailyArchives.push({
      ...JSON.parse(JSON.stringify(state.currentEvent)),
      archivedAtMs: nowMs,
      finalStoresSnapshot: JSON.parse(JSON.stringify(state.stores))
    });
  }
  state.currentEvent = null;

  // Reset weekly ledger for the new week
  const newWeeklyStoreLedger = {};
  for (const meta of OFFICIAL_ROSTER) {
    newWeeklyStoreLedger[meta.id] = {
      storeId: meta.id,
      name: meta.name,
      cumulativeEarnedBp: 0,
      cumulativeSalesEarnedBp: 0,
      cumulativeAdminBonusBp: 0,
      dailyBreakdown: {},
      qualifierCount: 0
    };
  }

  state.currentWeek = {
    ...targetWeek,
    countedDaysHeld: [],
    dailyQualifiersByDate: {},
    weeklyStoreLedger: newWeeklyStoreLedger,
    weeklyTieResolution: null
  };

  // Initialize new daily event for the current date in the new week
  const parts = getEasternParts(nowMs);
  // If it's Sunday >= 7:00 PM ET, next daily event is Monday
  const nextEventDateKey = parts.dayOfWeek === 0 && parts.hour >= 19
    ? targetWeek.eventDateKeys[0]
    : parts.dateKey;

  initializeDailyEventForDate(state, nextEventDateKey, nowMs);

  state.auditLog.push({
    auditId: generateId('aud'),
    timestampMs: nowMs,
    action: 'WEEKLY_ROLLOVER',
    details: {
      newWeekId: targetWeek.weekId,
      nextEventDateKey
    }
  });

  return { rolledOver: true, weekId: targetWeek.weekId };
}

/**
 * Queue a sales delta (from manual entry or reconciled Google Sheet import).
 * Enforces the 3-minute sales cutoff rule (Section 8):
 * - Sales submitted at or before a scheduled cutoff become eligible at that cutoff.
 * - Sales submitted after a cutoff remain pending until the next cutoff.
 * - Sales submitted at or before event start are released at event start.
 */
function enqueueSalesEntry(state, {
  storeId,
  category, // 'vl' | 'beyondVl_standalone' | 'beyondVl_classified' | 'watches' | 'tablets' | 'bts' | 'hsi' | 'accCents'
  qty = 0,
  accCents = 0,
  sourceTimestampMs = null,
  ingestedAtMs = Date.now(),
  source = 'MANUAL',
  note = ''
}) {
  const store = state.stores[storeId];
  if (!store) {
    throw new Error(`Unknown store ID: ${storeId}`);
  }

  const effectiveTimestampMs = sourceTimestampMs !== null && sourceTimestampMs !== undefined
    ? Number(sourceTimestampMs)
    : Number(ingestedAtMs);

  const evt = state.currentEvent;

  // Check if sale crosses daily or weekly boundary or arrives after event closing (Section 8 & 17)
  if (
    evt &&
    (evt.status === 'ENDED_NORMAL' ||
      evt.status === 'ENDED_DRAW' ||
      effectiveTimestampMs > evt.scheduledCloseMs)
  ) {
    const issue = {
      issueId: generateId('iss'),
      type: 'LATE_CROSS_BOUNDARY_SALE',
      storeId,
      category,
      qty,
      accCents,
      sourceTimestampMs,
      ingestedAtMs,
      effectiveTimestampMs,
      source,
      note,
      createdAtMs: ingestedAtMs,
      resolved: false,
      description: `Late sale for ${storeId} (${category}) arrived after event closing or across boundary. Explicit Admin attribution required.`
    };
    state.reconciliationIssues.push(issue);
    return { status: 'QUARANTINED_LATE_SALE', issue };
  }

  // Compute base basis points and quantity delta for this entry
  let basePointsBp = 0;
  const qDelta = {
    totalVl: 0,
    watches: 0,
    tablets: 0,
    hsi: 0,
    accCents: 0
  };

  if (category === 'vl') {
    qDelta.totalVl = Math.trunc(Number(qty));
    basePointsBp = qDelta.totalVl * POINTS_CONFIG.VL_POINTS * BP_PER_POINT;
  } else if (category === 'watches') {
    qDelta.watches = Math.trunc(Number(qty));
    basePointsBp = qDelta.watches * POINTS_CONFIG.BTS_POINTS * BP_PER_POINT;
  } else if (category === 'tablets') {
    qDelta.tablets = Math.trunc(Number(qty));
    basePointsBp = qDelta.tablets * POINTS_CONFIG.BTS_POINTS * BP_PER_POINT;
  } else if (category === 'bts') {
    qDelta.watches = Math.trunc(Number(qty));
    basePointsBp = qDelta.watches * POINTS_CONFIG.BTS_POINTS * BP_PER_POINT;
  } else if (category === 'hsi') {
    qDelta.hsi = Math.trunc(Number(qty));
    basePointsBp = qDelta.hsi * POINTS_CONFIG.HSI_POINTS * BP_PER_POINT;
  } else if (category === 'acc' || category === 'accCents') {
    const cents = category === 'accCents' ? Math.trunc(Number(accCents || qty)) : parseDollarsToCents(qty);
    qDelta.accCents = cents;
    basePointsBp = cents * 2; // 1 cent = 2 bp ($1.00 = 2 pts)
  } else {
    throw new Error(`Unsupported sales category: ${category}`);
  }

  const prevPendingBp = store.pendingBp;

  // Add to store's pending quantities first, then recompute derived totals (including +300 per 300 sales milestone bonus)
  store.pendingQuantities.totalVl += qDelta.totalVl;
  store.pendingQuantities.watches += qDelta.watches;
  store.pendingQuantities.tablets += qDelta.tablets;
  store.pendingQuantities.hsi += qDelta.hsi;
  store.pendingQuantities.accCents += qDelta.accCents;
  syncStoreDerivedTotals(store);

  const effectiveDeltaBp = Math.max(basePointsBp, store.pendingBp - prevPendingBp);

  const saleRecord = {
    saleId: generateId('sale'),
    storeId,
    category,
    qty: Number(qty || 0),
    accCents: qDelta.accCents,
    qDelta,
    basePointsBp,
    basePoints: bpToPoints(basePointsBp),
    pointsBp: effectiveDeltaBp,
    points: bpToPoints(effectiveDeltaBp),
    sourceTimestampMs,
    ingestedAtMs,
    effectiveTimestampMs,
    source,
    note,
    status: 'PENDING',
    releasedAtCutoffKey: null,
    releasedAtMs: null
  };

  state.pendingSalesQueue.push(saleRecord);
  state.salesLog.push({
    ...saleRecord
  });

  // Track manual entries for reconciliation against subsequent Google Sheet imports
  if (source === 'MANUAL') {
    state.unreconciledManualEntries.push({
      entryId: saleRecord.saleId,
      storeId,
      category,
      qDelta: { ...qDelta },
      createdAtMs: ingestedAtMs,
      note,
      reconciled: false
    });
  }

  return { status: 'QUEUED', saleRecord };
}

/**
 * Release all pending sales whose effectiveTimestampMs <= cutoffMs.
 */
function releasePendingSalesUpToCutoff(state, cutoffMs, cutoffKey) {
  let releasedCount = 0;
  let releasedTotalBp = 0;

  for (const item of state.pendingSalesQueue) {
    if (item.status === 'PENDING' && item.effectiveTimestampMs <= cutoffMs) {
      const store = state.stores[item.storeId];
      let deltaEarnedBp = item.pointsBp;
      if (store) {
        const prevSalesEarnedBp = store.salesEarnedBp;

        store.pendingQuantities.totalVl = Math.max(0, store.pendingQuantities.totalVl - item.qDelta.totalVl);
        store.pendingQuantities.watches = Math.max(0, store.pendingQuantities.watches - item.qDelta.watches);
        store.pendingQuantities.tablets = Math.max(0, store.pendingQuantities.tablets - item.qDelta.tablets);
        store.pendingQuantities.hsi = Math.max(0, store.pendingQuantities.hsi - item.qDelta.hsi);
        store.pendingQuantities.accCents = Math.max(0, store.pendingQuantities.accCents - item.qDelta.accCents);

        store.quantities.totalVl += item.qDelta.totalVl;
        store.quantities.watches += item.qDelta.watches;
        store.quantities.tablets += item.qDelta.tablets;
        store.quantities.hsi += item.qDelta.hsi;
        store.quantities.accCents += item.qDelta.accCents;

        syncStoreDerivedTotals(store);
        deltaEarnedBp = Math.max(0, store.salesEarnedBp - prevSalesEarnedBp);
        store.availableBp += deltaEarnedBp;
      }

      item.status = 'RELEASED';
      item.releasedAtCutoffKey = cutoffKey;
      item.releasedAtMs = cutoffMs;
      item.pointsBp = deltaEarnedBp;
      item.points = bpToPoints(deltaEarnedBp);

      const logMatch = state.salesLog.find(s => s.saleId === item.saleId);
      if (logMatch) {
        logMatch.status = 'RELEASED';
        logMatch.releasedAtCutoffKey = cutoffKey;
        logMatch.releasedAtMs = cutoffMs;
        logMatch.pointsBp = deltaEarnedBp;
        logMatch.points = bpToPoints(deltaEarnedBp);
      }

      releasedCount++;
      releasedTotalBp += deltaEarnedBp;
    }
  }

  state.currentEvent.processedCutoffs[cutoffKey] = cutoffMs;
  if (releasedCount > 0) {
    syncWeeklyLedgerFromDailyEvent(state);
  }
  return { releasedCount, releasedTotalBp };
}

/**
 * Process Power Phase Entry (Section 12):
 * - Standing stores need at least 350 AVAILABLE points (35,000 bp).
 * - Eliminate standing stores below 350.
 * - Already knocked-out stores remain out.
 * - DRAW: If every remaining standing store is below 350 (or if no standing stores exist),
 *   end the daily event immediately as a DRAW, record no daily qualifiers, and preserve
 *   sales figures & earned points for the next daily event within the week.
 */
function processPowerPhaseEntry(state, boundaryMs) {
  const evt = state.currentEvent;
  if (!evt || evt.powerPhaseEntryChecked) return;

  evt.powerPhaseEntryChecked = true;
  evt.phase = 'POWER_PHASE';

  // Disable all active deflections for Power phase
  for (const st of Object.values(state.stores)) {
    st.deflection.activeForRoundId = null;
  }

  const minBp = POINTS_CONFIG.POWER_PHASE_MIN_AVAILABLE * BP_PER_POINT; // 35,000 bp (350 pts)
  const standingStores = Object.values(state.stores).filter(s => s.status === 'STANDING');
  const qualifyingStores = standingStores.filter(s => s.availableBp >= minBp);
  const belowMinStores = standingStores.filter(s => s.availableBp < minBp);

  const balancesSnapshot = {};
  for (const s of Object.values(state.stores)) {
    balancesSnapshot[s.id] = {
      status: s.status,
      availableBp: s.availableBp,
      availablePoints: bpToPoints(s.availableBp),
      totalEarnedBp: s.totalEarnedBp,
      totalEarnedPoints: bpToPoints(s.totalEarnedBp)
    };
  }

  if (standingStores.length === 0 || qualifyingStores.length === 0) {
    // Eliminate any remaining standing stores that were below 350
    for (const st of belowMinStores) {
      st.status = 'KNOCKED_OUT';
      st.eliminatedReason = 'POWER_PHASE_BELOW_350_DRAW';
      st.eliminatedAtMs = boundaryMs;
      st.timesKnockedOutToday += 1;
    }

    evt.status = 'ENDED_DRAW';
    evt.phase = 'CLOSED';
    evt.actualCloseMs = boundaryMs;
    evt.activeRoundId = null;
    evt.dailyQualifiers = [];
    evt.drawReason =
      standingStores.length === 0
        ? 'No stores were standing at Power phase entry.'
        : 'All remaining standing stores were below the 350 available-point minimum at Power phase entry.';
    evt.drawBalancesSnapshot = balancesSnapshot;

    state.currentWeek.dailyQualifiersByDate[evt.dateKey] = [];
    syncWeeklyLedgerFromDailyEvent(state);

    state.auditLog.push({
      auditId: generateId('aud'),
      timestampMs: boundaryMs,
      action: 'POWER_PHASE_DRAW',
      details: {
        eventId: evt.eventId,
        reason: evt.drawReason,
        balancesSnapshot
      }
    });
    return;
  }

  // At least one store has >= 350 available points: eliminate those below 350
  for (const st of belowMinStores) {
    st.status = 'KNOCKED_OUT';
    st.eliminatedReason = 'POWER_PHASE_BELOW_350';
    st.eliminatedAtMs = boundaryMs;
    st.timesKnockedOutToday += 1;

    state.combatLog.push({
      actionId: generateId('elim'),
      type: 'POWER_PHASE_ELIMINATION',
      eventId: evt.eventId,
      targetId: st.id,
      availableBpAtCheck: st.availableBp,
      availablePointsAtCheck: bpToPoints(st.availableBp),
      serverTimestamp: new Date(boundaryMs).toISOString(),
      timestampMs: boundaryMs,
      reason: 'Below 350 available points at Power Phase entry'
    });
  }
}

/**
 * Process a scheduled Automatic Elimination Checkpoint (Section 14):
 * - Stop scheduled eliminations when only 1 store remains standing.
 * - Eliminate 1 standing store:
 *   1. Fewest available points (availableBp).
 *   2. If tied, fewest sales-earned points (salesEarnedBp).
 *   3. If still tied, pause that checkpoint's selection for Admin resolution!
 */
function processEliminationCheckpoint(state, checkpoint, boundaryMs) {
  const evt = state.currentEvent;
  if (!evt || evt.status === 'ENDED_DRAW' || evt.status === 'ENDED_NORMAL') return;
  if (evt.processedCheckpoints[checkpoint.checkpointId]) return;
  // If a prior checkpoint tie is still unresolved, wait until Admin resolves it
  if (evt.pendingEliminationTie) return;

  const standingStores = Object.values(state.stores).filter(s => s.status === 'STANDING');
  if (standingStores.length <= 1) {
    evt.processedCheckpoints[checkpoint.checkpointId] = {
      processedAtMs: boundaryMs,
      eliminatedStoreId: null,
      status: 'SKIPPED_LAST_SURVIVOR'
    };
    return;
  }

  // Sort ascending by availableBp, then ascending by salesEarnedBp
  standingStores.sort((a, b) => {
    if (a.availableBp !== b.availableBp) return a.availableBp - b.availableBp;
    return a.salesEarnedBp - b.salesEarnedBp;
  });

  const lowest = standingStores[0];
  const tiedCandidates = standingStores.filter(
    s => s.availableBp === lowest.availableBp && s.salesEarnedBp === lowest.salesEarnedBp
  );

  if (tiedCandidates.length > 1) {
    // Pause checkpoint selection for Admin resolution (Section 14)
    evt.pendingEliminationTie = {
      checkpointId: checkpoint.checkpointId,
      checkpointLabel: checkpoint.label,
      timestampMs: boundaryMs,
      isPowerPhase: checkpoint.isPowerPhase,
      candidateStoreIds: tiedCandidates.map(c => c.id),
      candidateSnapshots: tiedCandidates.map(c => ({
        storeId: c.id,
        name: c.name,
        availableBp: c.availableBp,
        availablePoints: bpToPoints(c.availableBp),
        salesEarnedBp: c.salesEarnedBp,
        salesEarnedPoints: bpToPoints(c.salesEarnedBp)
      }))
    };
    if (boundaryMs >= evt.scheduledCloseMs) {
      evt.status = 'AWAITING_TIE_RESOLUTION';
    }
    state.auditLog.push({
      auditId: generateId('aud'),
      timestampMs: boundaryMs,
      action: 'ELIMINATION_CHECKPOINT_TIE_PAUSED',
      details: evt.pendingEliminationTie
    });
    return;
  }

  // Eliminate the single lowest store
  lowest.status = 'KNOCKED_OUT';
  lowest.eliminatedReason = `CHECKPOINT_${checkpoint.label}`;
  lowest.eliminatedAtMs = boundaryMs;
  lowest.timesKnockedOutToday += 1;

  evt.processedCheckpoints[checkpoint.checkpointId] = {
    processedAtMs: boundaryMs,
    eliminatedStoreId: lowest.id,
    status: 'ELIMINATED',
    availableBp: lowest.availableBp,
    salesEarnedBp: lowest.salesEarnedBp
  };

  state.combatLog.push({
    actionId: generateId('chk_elim'),
    type: 'SCHEDULED_ELIMINATION',
    eventId: evt.eventId,
    checkpointId: checkpoint.checkpointId,
    checkpointLabel: checkpoint.label,
    targetId: lowest.id,
    targetBalanceBefore: bpToPoints(lowest.availableBp),
    targetSalesEarnedPoints: bpToPoints(lowest.salesEarnedBp),
    canSelfRevive: !checkpoint.isPowerPhase && evt.phase !== 'POWER_PHASE',
    serverTimestamp: new Date(boundaryMs).toISOString(),
    timestampMs: boundaryMs
  });
}

/**
 * Open a Battle Round at `round.startMs` (Sections 7, 11, 13, 15 step 6):
 * - Snapshot Deflection eligibility for the round:
 *   - Regular hours only (disabled in Power phase)
 *   - Current time >= evt.deflectionUnlockMs (actualStartMs + 120 mins)
 *   - Store has qualifiedForDay (survived >= 2 accepted incoming attacks in first 120 mins)
 *   - Store is STANDING
 *   - Store has >= 1,350 available points (135,000 bp) at round start
 * - Activate any queued Shields for this round (Power phase only, blocks attacks for first 3 minutes).
 */
function openBattleRound(state, round) {
  const evt = state.currentEvent;
  if (!evt || evt.status !== 'ACTIVE') return;

  evt.activeRoundId = round.roundId;
  const isPowerPhase = evt.phase === 'POWER_PHASE' || round.isPowerPhase;
  const deflectionUnlocked = round.startMs >= evt.deflectionUnlockMs && !isPowerPhase;
  const minDeflectBp = POINTS_CONFIG.DEFLECTION_MIN_AVAILABLE * BP_PER_POINT; // 135,000 bp

  const deflectionSnapshot = {};
  const shieldActiveStores = {};

  for (const st of Object.values(state.stores)) {
    // 1. Deflection snapshot
    const eligibleForDeflection =
      deflectionUnlocked &&
      st.status === 'STANDING' &&
      st.deflection.qualifiedForDay &&
      st.availableBp >= minDeflectBp;

    deflectionSnapshot[st.id] = Boolean(eligibleForDeflection);
    st.deflection.activeForRoundId = eligibleForDeflection ? round.roundId : null;
    st.deflection.brokenInRoundId = null;

    // 2. Shield activation (Power phase only)
    if (st.shield.queuedForRoundId === round.roundId) {
      st.shield.queuedForRoundId = null;
      st.shield.activeRoundId = round.roundId;
      st.shield.protectedUntilMs = round.shieldProtectedUntilMs;
      shieldActiveStores[st.id] = round.shieldProtectedUntilMs;
    }
  }

  evt.roundStates[round.roundId] = {
    roundId: round.roundId,
    label: round.label,
    status: 'OPEN',
    startMs: round.startMs,
    endMs: round.endMs,
    shieldProtectedUntilMs: round.shieldProtectedUntilMs,
    isPowerPhase,
    attacksByStore: {}, // { [storeId]: count (max 2) }
    deflectedHits: {}, // { [attackerId]: { [targetId]: true } }
    deflectionSnapshot,
    shieldActiveStores
  };
}

/**
 * Close a Battle Round at `round.endMs` (Section 15 step 1).
 */
function closeBattleRound(state, roundId, closeMs) {
  const evt = state.currentEvent;
  if (!evt) return;
  const rState = evt.roundStates[roundId];
  if (rState && rState.status === 'OPEN') {
    rState.status = 'CLOSED';
    rState.closedAtMs = closeMs;
  }
  if (evt.activeRoundId === roundId) {
    evt.activeRoundId = null;
  }
  for (const st of Object.values(state.stores)) {
    if (st.deflection.activeForRoundId === roundId) {
      st.deflection.activeForRoundId = null;
    }
    if (st.shield.activeRoundId === roundId) {
      st.shield.activeRoundId = null;
      st.shield.protectedUntilMs = null;
      st.shield.lastExpiredRoundId = roundId;
    }
  }
}

/**
 * Finalize Daily Event Closing (Section 15):
 * - Do not finalize while a required admin elimination tie resolution remains unresolved.
 * - Record all surviving STANDING stores as DAILY QUALIFIERS (not daily winners).
 * - Archive daily event.
 */
function finalizeDailyClosing(state, closeMs) {
  const evt = state.currentEvent;
  if (!evt || evt.status === 'ENDED_DRAW' || evt.status === 'ENDED_NORMAL') return;

  if (evt.pendingEliminationTie) {
    evt.status = 'AWAITING_TIE_RESOLUTION';
    return;
  }

  evt.status = 'ENDED_NORMAL';
  evt.phase = 'CLOSED';
  evt.actualCloseMs = closeMs;
  evt.activeRoundId = null;

  const qualifiers = Object.values(state.stores)
    .filter(s => s.status === 'STANDING')
    .map(s => s.id);

  evt.dailyQualifiers = qualifiers;
  state.currentWeek.dailyQualifiersByDate[evt.dateKey] = qualifiers;
  syncWeeklyLedgerFromDailyEvent(state);

  if (!state.dailyArchives.some(a => a.eventId === evt.eventId)) {
    state.dailyArchives.push({
      ...JSON.parse(JSON.stringify(evt)),
      archivedAtMs: closeMs,
      finalStoresSnapshot: JSON.parse(JSON.stringify(state.stores))
    });
  }

  state.auditLog.push({
    auditId: generateId('aud'),
    timestampMs: closeMs,
    action: 'DAILY_EVENT_CLOSED',
    details: {
      eventId: evt.eventId,
      dateKey: evt.dateKey,
      dailyQualifiers: qualifiers
    }
  });
}

/**
 * Deterministic Boundary Processor (Section 15):
 * Processes all scheduled boundaries up to `nowMs` in exact chronological order,
 * and at any shared timestamp `T`, strictly executes:
 *   1. Close a round ending at `T`.
 *   2. Release points eligible at a scheduled cutoff at `T`.
 *   3. Process phase transitions at `T`.
 *   4. At Power phase entry, resolve the 350-point check / draw.
 *   5. Process a coinciding automatic elimination at `T`.
 *   6. Open a round starting at `T` and snapshot defenses.
 *   7. (At daily closing `T`, finalize daily closing after step 5).
 */
function processScheduledBoundaries(state, nowMs = Date.now()) {
  // Check if Sunday 7:00 PM ET weekly rollover has been reached
  const expectedWeek = getWeeklyPeriodForTimestamp(nowMs);
  if (state.currentWeek && nowMs >= state.currentWeek.nextStartMs) {
    performWeeklyRollover(state, nowMs);
  }

  const evt = state.currentEvent;
  if (!evt) return state;

  // Check if we moved to a new calendar day within the same week and prior day's event is over
  const nowParts = getEasternParts(nowMs);
  if (
    nowParts.dateKey > evt.dateKey &&
    (evt.status === 'SCHEDULED' || evt.status === 'ENDED_NORMAL' || evt.status === 'ENDED_DRAW')
  ) {
    initializeDailyEventForDate(state, nowParts.dateKey, nowMs);
  }

  const currentEvt = state.currentEvent;
  if (!currentEvt) return state;

  // Auto-start scheduled event on an enabled day if nowMs >= scheduledStartMs and status is SCHEDULED
  if (
    currentEvt.status === 'SCHEDULED' &&
    isEventDayEnabled(state, currentEvt.dateKey) &&
    nowMs >= currentEvt.scheduledStartMs
  ) {
    startDailyEvent(state, currentEvt.scheduledStartMs, false);
  }

  if (currentEvt.status !== 'ACTIVE' && currentEvt.status !== 'PAUSED' && currentEvt.status !== 'AWAITING_TIE_RESOLUTION') {
    return state;
  }

  const schedule = getDailyScheduleForDateKey(
    currentEvt.dateKey,
    currentEvt.customRounds,
    currentEvt.actualStartMs || currentEvt.scheduledStartMs
  );

  // Collect all distinct boundary timestamps <= nowMs
  const timestampSet = new Set();

  // Event start cutoff release
  const startCutoffMs = schedule.effectiveStartMs;
  if (startCutoffMs <= nowMs) timestampSet.add(startCutoffMs);

  // Round cutoffs, starts, and ends
  for (const r of schedule.rounds) {
    if (r.cutoffMs <= nowMs) timestampSet.add(r.cutoffMs);
    if (r.startMs <= nowMs) timestampSet.add(r.startMs);
    if (r.endMs <= nowMs) timestampSet.add(r.endMs);
  }

  // Phase boundaries
  if (schedule.finalStretchStartMs <= nowMs) timestampSet.add(schedule.finalStretchStartMs);
  if (schedule.powerPhaseStartMs <= nowMs) timestampSet.add(schedule.powerPhaseStartMs);
  if (schedule.eventCloseMs <= nowMs) timestampSet.add(schedule.eventCloseMs);

  // Elimination checkpoints
  for (const chk of schedule.eliminationCheckpoints) {
    if (chk.timestampMs <= nowMs) timestampSet.add(chk.timestampMs);
  }

  const sortedTimestamps = Array.from(timestampSet).sort((a, b) => a - b);

  for (const T of sortedTimestamps) {
    if (currentEvt.status === 'ENDED_DRAW' || currentEvt.status === 'ENDED_NORMAL') break;

    // STEP 1: Close any round ending at T
    for (const r of schedule.rounds) {
      if (r.endMs === T && currentEvt.roundStates[r.roundId]?.status === 'OPEN') {
        closeBattleRound(state, r.roundId, T);
      }
    }

    // STEP 2: Release points eligible at a scheduled cutoff at T
    if (T === startCutoffMs && !currentEvt.processedCutoffs['cutoff_event_start']) {
      releasePendingSalesUpToCutoff(state, T, 'cutoff_event_start');
    }
    for (const r of schedule.rounds) {
      const cutoffKey = `cutoff_${r.roundId}`;
      if (r.cutoffMs === T && !currentEvt.processedCutoffs[cutoffKey]) {
        releasePendingSalesUpToCutoff(state, T, cutoffKey);
      }
    }

    // STEP 3: Process phase transitions at T
    if (T >= schedule.finalStretchStartMs && T < schedule.powerPhaseStartMs && currentEvt.phase === 'REGULAR_HOURS') {
      currentEvt.phase = 'FINAL_STRETCH';
    }

    // STEP 4: At Power phase entry, resolve the 350-point check / draw
    if (T === schedule.powerPhaseStartMs && !currentEvt.powerPhaseEntryChecked) {
      processPowerPhaseEntry(state, T);
      if (currentEvt.status === 'ENDED_DRAW') break;
    }

    // STEP 5: Process a coinciding automatic elimination checkpoint at T
    for (const chk of schedule.eliminationCheckpoints) {
      if (chk.timestampMs === T && !currentEvt.processedCheckpoints[chk.checkpointId]) {
        processEliminationCheckpoint(state, chk, T);
      }
    }

    // STEP 6: Open a round starting at T and snapshot defenses (only if T < nowMs or T === nowMs and round hasn't ended yet)
    for (const r of schedule.rounds) {
      if (r.startMs === T && !currentEvt.roundStates[r.roundId] && T < schedule.eventCloseMs) {
        openBattleRound(state, r);
        // If T is in the past and r.endMs <= nowMs, it will be closed when the loop hits r.endMs
      }
    }

    // Daily Event Closing at T === schedule.eventCloseMs
    if (T === schedule.eventCloseMs) {
      finalizeDailyClosing(state, T);
    }
  }

  syncWeeklyLedgerFromDailyEvent(state);
  return state;
}

/**
 * Start a Daily Event (Admin or Scheduled).
 */
function startDailyEvent(state, nowMs = Date.now(), isManualAdminStart = false) {
  const evt = state.currentEvent;
  if (!evt) throw new Error('No current event initialized.');
  if (evt.status === 'ACTIVE') return state;

  const schedule = getDailyScheduleForDateKey(evt.dateKey, evt.customRounds, nowMs);
  evt.status = 'ACTIVE';
  evt.actualStartMs = nowMs;
  evt.deflectionUnlockMs = nowMs + 120 * 60 * 1000;

  if (nowMs >= schedule.powerPhaseStartMs) {
    evt.phase = 'POWER_PHASE';
  } else if (nowMs >= schedule.finalStretchStartMs) {
    evt.phase = 'FINAL_STRETCH';
  } else {
    evt.phase = 'REGULAR_HOURS';
  }

  releasePendingSalesUpToCutoff(state, nowMs, 'cutoff_event_start');
  syncWeeklyLedgerFromDailyEvent(state);

  state.auditLog.push({
    auditId: generateId('aud'),
    timestampMs: nowMs,
    action: isManualAdminStart ? 'ADMIN_START_EVENT' : 'SCHEDULED_START_EVENT',
    details: {
      eventId: evt.eventId,
      dateKey: evt.dateKey,
      actualStartMs: nowMs,
      deflectionUnlockMs: evt.deflectionUnlockMs
    }
  });

  return state;
}

/**
 * Execute a Store Attack during an active Battle Round (Sections 9, 11, 13, 18):
 * - Enforces event active, round open, 2-attack allowance per round, no self-attack,
 *   attacker standing, target standing, target not shielded.
 * - Normal attack: cost 200, damage 400.
 * - Against active Deflection:
 *   - Simple attack: cost 200, damage 100. Records landed deflected hit for (attackerId, targetId) in this round.
 *   - Deflection Breaker: available ONLY if same attacker already landed a deflected hit on same target in same round
 *     and chooses attackMode === 'BREAKER'. Cost 400, damage 500, breaks target's deflection for remainder of round.
 * - Tracks survival in first 120 minutes ([actualStartMs, actualStartMs + 120 mins)) for Deflection qualification.
 */
function executeAttack(state, {
  attackerId,
  targetId,
  attackMode = 'NORMAL', // 'NORMAL' | 'SIMPLE' | 'BREAKER'
  idempotencyKey = null,
  note = '',
  nowMs = Date.now()
}) {
  if (idempotencyKey && state.processedIdempotencyKeys[idempotencyKey]) {
    return {
      duplicate: true,
      ...state.processedIdempotencyKeys[idempotencyKey].resultSummary
    };
  }

  processScheduledBoundaries(state, nowMs);

  const evt = state.currentEvent;
  if (!evt || evt.status !== 'ACTIVE') {
    throw new Error('Daily event is not currently active.');
  }
  if (!evt.activeRoundId) {
    throw new Error('No Battle Round is currently open! Attacks are only accepted during 5-minute Battle Rounds (:10, :30, :50).');
  }

  const rState = evt.roundStates[evt.activeRoundId];
  if (!rState || rState.status !== 'OPEN' || nowMs < rState.startMs || nowMs >= rState.endMs) {
    throw new Error('The Battle Round is not open.');
  }

  const attacker = state.stores[attackerId];
  const target = state.stores[targetId];
  if (!attacker) throw new Error(`Invalid attacker store: ${attackerId}`);
  if (!target) throw new Error(`Invalid target store: ${targetId}`);
  if (attackerId === targetId) {
    throw new Error('Self-attacks are prohibited.');
  }
  if (attacker.status !== 'STANDING') {
    throw new Error(`${attacker.name} is knocked out and cannot attack.`);
  }
  if (target.status !== 'STANDING') {
    throw new Error(`${target.name} is already knocked out and cannot be targeted.`);
  }

  // Check 2-attack allowance per store per round
  const attacksUsed = Number(rState.attacksByStore[attackerId] || 0);
  if (attacksUsed >= 2) {
    throw new Error(`${attacker.name} has already used the maximum 2 attacks in this Battle Round.`);
  }

  // Check if target is protected by an active Shield (first 3 minutes of round in Power Phase)
  const shieldProtectedUntil = rState.shieldActiveStores?.[targetId] || target.shield.protectedUntilMs;
  if (shieldProtectedUntil && nowMs < shieldProtectedUntil) {
    throw new Error(`${target.name} is protected by an active Power Phase Shield until ${formatEasternTimeLabel(shieldProtectedUntil)}! Rejected attacks consume no points or allowance.`);
  }

  // Check target's Deflection state for this round
  const isPowerPhase = evt.phase === 'POWER_PHASE' || rState.isPowerPhase;
  const targetHasActiveDeflection =
    !isPowerPhase &&
    Boolean(rState.deflectionSnapshot?.[targetId]) &&
    target.deflection.activeForRoundId === rState.roundId &&
    target.deflection.brokenInRoundId !== rState.roundId;

  let resolvedAttackType = 'NORMAL';
  let costPts = POINTS_CONFIG.NORMAL_ATTACK_COST; // 200
  let damagePts = POINTS_CONFIG.NORMAL_ATTACK_DAMAGE; // 400
  let defenseState = 'NONE';

  if (targetHasActiveDeflection) {
    const alreadyLandedDeflectedHit = Boolean(rState.deflectedHits?.[attackerId]?.[targetId]);
    if (attackMode === 'BREAKER') {
      if (!alreadyLandedDeflectedHit) {
        throw new Error(`Deflection Breaker requires ${attacker.name} to have already landed a deflected hit on ${target.name} earlier in this SAME round.`);
      }
      resolvedAttackType = 'DEFLECTION_BREAKER';
      costPts = POINTS_CONFIG.DEFLECTION_BREAKER_COST; // 400
      damagePts = POINTS_CONFIG.DEFLECTION_BREAKER_DAMAGE; // 500
      defenseState = 'DEFLECTION_BROKEN';
    } else {
      resolvedAttackType = 'SIMPLE_DEFLECTED';
      costPts = POINTS_CONFIG.DEFLECTED_SIMPLE_COST; // 200
      damagePts = POINTS_CONFIG.DEFLECTED_SIMPLE_DAMAGE; // 100
      defenseState = 'DEFLECTED';
    }
  } else if (attackMode === 'BREAKER') {
    throw new Error(`${target.name} does not have active Deflection to break.`);
  }

  const costBp = costPts * BP_PER_POINT;
  const rawDamageBp = damagePts * BP_PER_POINT;

  if (attacker.availableBp < costBp) {
    throw new Error(`${attacker.name} needs ${costPts} available points to execute this attack (currently has ${formatBp(attacker.availableBp)}).`);
  }

  const attackerBalanceBeforeBp = attacker.availableBp;
  const targetBalanceBeforeBp = target.availableBp;

  // Deduct attacker cost
  attacker.availableBp -= costBp;
  attacker.attackSpentBp += costBp;
  rState.attacksByStore[attackerId] = attacksUsed + 1;

  // Apply damage to target (clamped to minimum of 0)
  const effectiveDamageBp = Math.min(target.availableBp, rawDamageBp);
  target.availableBp = Math.max(0, target.availableBp - rawDamageBp);
  target.incomingDamageBp += effectiveDamageBp;

  // Handle Deflection state updates
  if (resolvedAttackType === 'SIMPLE_DEFLECTED') {
    if (!rState.deflectedHits[attackerId]) rState.deflectedHits[attackerId] = {};
    rState.deflectedHits[attackerId][targetId] = true;
  } else if (resolvedAttackType === 'DEFLECTION_BREAKER') {
    target.deflection.brokenInRoundId = rState.roundId;
    target.deflection.activeForRoundId = null;
  }

  // Determine knockout vs survival
  // An accepted incoming attack leaving the target at 0 knocks it out (including a standing store already at 0!)
  const resultingKnockout = target.availableBp === 0;
  if (resultingKnockout) {
    target.status = 'KNOCKED_OUT';
    target.eliminatedReason = 'COMBAT_KNOCKOUT';
    target.eliminatedAtMs = nowMs;
    target.eliminatedByStoreId = attackerId;
    target.timesKnockedOutToday += 1;
    attacker.kosDealtToday += 1;
  } else {
    target.attacksSurvivedToday += 1;
    // Check if within first 120 minutes [actualStartMs, actualStartMs + 120 minutes) for Deflection qualification
    const startMs = evt.actualStartMs || evt.scheduledStartMs;
    if (nowMs >= startMs && nowMs < startMs + 120 * 60 * 1000) {
      target.deflection.survivedAttacksInFirst120 += 1;
      if (target.deflection.survivedAttacksInFirst120 >= 2) {
        target.deflection.qualifiedForDay = true;
      }
    }
  }

  const logEntry = {
    actionId: generateId('atk'),
    idempotencyKey: idempotencyKey || null,
    type: 'ATTACK',
    eventId: evt.eventId,
    roundId: rState.roundId,
    attackerId,
    targetId,
    attackType: resolvedAttackType,
    costPoints: costPts,
    costBp,
    damagePoints: damagePts,
    damageBp: rawDamageBp,
    effectiveDamagePoints: bpToPoints(effectiveDamageBp),
    effectiveDamageBp,
    defenseState,
    attackerBalanceBefore: bpToPoints(attackerBalanceBeforeBp),
    attackerBalanceAfter: bpToPoints(attacker.availableBp),
    targetBalanceBefore: bpToPoints(targetBalanceBeforeBp),
    targetBalanceAfter: bpToPoints(target.availableBp),
    resultingKnockout,
    note: String(note || '').slice(0, 140),
    serverTimestamp: new Date(nowMs).toISOString(),
    timestampMs: nowMs
  };

  state.combatLog.push(logEntry);

  if (idempotencyKey) {
    state.processedIdempotencyKeys[idempotencyKey] = {
      processedAtMs: nowMs,
      action: 'ATTACK',
      resultSummary: { logEntry }
    };
  }

  return { logEntry };
}

/**
 * Execute Self-Funded Revival (Section 10):
 * - Only self-funded revivals are permitted.
 * - Disabled during Power phase.
 * - Outside a battle round: 200 available points.
 * - During a battle round: 400 available points.
 * - Preserves used attack allowance for the current round and deflection qualification for the day.
 */
function executeRevival(state, {
  storeId,
  idempotencyKey = null,
  note = '',
  nowMs = Date.now()
}) {
  if (idempotencyKey && state.processedIdempotencyKeys[idempotencyKey]) {
    return {
      duplicate: true,
      ...state.processedIdempotencyKeys[idempotencyKey].resultSummary
    };
  }

  processScheduledBoundaries(state, nowMs);

  const evt = state.currentEvent;
  if (!evt || evt.status !== 'ACTIVE') {
    throw new Error('Daily event is not currently active.');
  }
  if (evt.phase === 'POWER_PHASE' || nowMs >= evt.powerPhaseStartMs) {
    throw new Error('Revivals are permanently disabled during the Power Phase! Knockouts are permanent through daily closing.');
  }

  const store = state.stores[storeId];
  if (!store) throw new Error(`Unknown store: ${storeId}`);
  if (store.status === 'STANDING') {
    throw new Error(`${store.name} is already standing.`);
  }

  const inActiveRound = Boolean(
    evt.activeRoundId &&
      evt.roundStates[evt.activeRoundId]?.status === 'OPEN' &&
      nowMs >= evt.roundStates[evt.activeRoundId].startMs &&
      nowMs < evt.roundStates[evt.activeRoundId].endMs
  );

  const costPts = inActiveRound
    ? POINTS_CONFIG.REVIVE_DURING_ROUND_COST // 400
    : POINTS_CONFIG.REVIVE_OUTSIDE_ROUND_COST; // 200
  const costBp = costPts * BP_PER_POINT;

  if (store.availableBp < costBp) {
    throw new Error(`${store.name} needs ${costPts} available points to self-revive ${inActiveRound ? 'during a Battle Round' : 'outside a Battle Round'} (currently has ${formatBp(store.availableBp)}).`);
  }

  const balanceBeforeBp = store.availableBp;
  store.availableBp -= costBp;
  store.revivalSpentBp += costBp;
  store.status = 'STANDING';
  store.eliminatedReason = null;
  store.eliminatedAtMs = null;
  store.eliminatedByStoreId = null;
  store.timesRevivedToday += 1;

  const logEntry = {
    actionId: generateId('rev'),
    idempotencyKey: idempotencyKey || null,
    type: 'REVIVE',
    eventId: evt.eventId,
    roundId: inActiveRound ? evt.activeRoundId : null,
    storeId,
    inActiveRound,
    costPoints: costPts,
    costBp,
    balanceBefore: bpToPoints(balanceBeforeBp),
    balanceAfter: bpToPoints(store.availableBp),
    note: String(note || '').slice(0, 140),
    serverTimestamp: new Date(nowMs).toISOString(),
    timestampMs: nowMs
  };

  state.combatLog.push(logEntry);

  if (idempotencyKey) {
    state.processedIdempotencyKeys[idempotencyKey] = {
      processedAtMs: nowMs,
      action: 'REVIVE',
      resultSummary: { logEntry }
    };
  }

  return { logEntry };
}

/**
 * Purchase a Power Phase Shield (Section 13):
 * - Available ONLY during the Power phase.
 * - Purchased ONLY BETWEEN active battle rounds.
 * - Cost: 600 available points.
 * - Maximum 1 purchase per store for each upcoming round.
 * - Assigned to the next eligible round; activates at round start for the first 3 minutes.
 */
function purchaseShield(state, {
  storeId,
  idempotencyKey = null,
  nowMs = Date.now()
}) {
  if (idempotencyKey && state.processedIdempotencyKeys[idempotencyKey]) {
    return {
      duplicate: true,
      ...state.processedIdempotencyKeys[idempotencyKey].resultSummary
    };
  }

  processScheduledBoundaries(state, nowMs);

  const evt = state.currentEvent;
  if (!evt || evt.status !== 'ACTIVE') {
    throw new Error('Daily event is not currently active.');
  }
  if (evt.phase !== 'POWER_PHASE' || nowMs < evt.powerPhaseStartMs) {
    throw new Error('Shields are only available during the Power Phase!');
  }

  const inActiveRound = Boolean(
    evt.activeRoundId &&
      evt.roundStates[evt.activeRoundId]?.status === 'OPEN' &&
      nowMs >= evt.roundStates[evt.activeRoundId].startMs &&
      nowMs < evt.roundStates[evt.activeRoundId].endMs
  );
  if (inActiveRound) {
    throw new Error('Shields can only be purchased BETWEEN active Battle Rounds, never mid-round!');
  }

  const store = state.stores[storeId];
  if (!store) throw new Error(`Unknown store: ${storeId}`);
  if (store.status !== 'STANDING') {
    throw new Error('Knocked-out stores cannot purchase a Shield.');
  }

  const schedule = getDailyScheduleForDateKey(
    evt.dateKey,
    evt.customRounds,
    evt.actualStartMs || evt.scheduledStartMs
  );
  const nextRound = schedule.rounds.find(r => r.startMs > nowMs && r.endMs <= evt.scheduledCloseMs);
  if (!nextRound) {
    throw new Error('No eligible upcoming Battle Round remains before event closing.');
  }

  if (store.shield.queuedForRoundId === nextRound.roundId) {
    throw new Error(`${store.name} already has a Shield queued for ${nextRound.label}. Maximum one Shield per upcoming round.`);
  }

  const costPts = POINTS_CONFIG.SHIELD_COST; // 600
  const costBp = costPts * BP_PER_POINT;
  if (store.availableBp < costBp) {
    throw new Error(`${store.name} needs ${costPts} available points to purchase a Shield (currently has ${formatBp(store.availableBp)}).`);
  }

  const balanceBeforeBp = store.availableBp;
  store.availableBp -= costBp;
  store.shieldSpentBp += costBp;
  store.shield.queuedForRoundId = nextRound.roundId;
  store.shield.purchasedAtMs = nowMs;

  const logEntry = {
    actionId: generateId('shd'),
    idempotencyKey: idempotencyKey || null,
    type: 'SHIELD_PURCHASE',
    eventId: evt.eventId,
    storeId,
    queuedForRoundId: nextRound.roundId,
    queuedForRoundLabel: nextRound.label,
    costPoints: costPts,
    costBp,
    balanceBefore: bpToPoints(balanceBeforeBp),
    balanceAfter: bpToPoints(store.availableBp),
    serverTimestamp: new Date(nowMs).toISOString(),
    timestampMs: nowMs
  };

  state.combatLog.push(logEntry);

  if (idempotencyKey) {
    state.processedIdempotencyKeys[idempotencyKey] = {
      processedAtMs: nowMs,
      action: 'SHIELD_PURCHASE',
      resultSummary: { logEntry }
    };
  }

  return { logEntry };
}

/**
 * Admin: Announce an additional custom Battle Round (Section 7):
 * - At least 5 minutes before starting (nowMs <= startMs - 5 mins).
 * - Lasts 5 minutes.
 * - Never overlaps another scheduled or custom round.
 * - Never extends beyond event closing.
 */
function announceCustomRound(state, { startMs, nowMs = Date.now(), adminNote = '' }) {
  processScheduledBoundaries(state, nowMs);
  const evt = state.currentEvent;
  if (!evt) throw new Error('No active event.');

  const rStartMs = Number(startMs);
  const rEndMs = rStartMs + 5 * 60 * 1000;
  const minLeadMs = 5 * 60 * 1000;

  if (rStartMs - nowMs < minLeadMs) {
    throw new Error('Additional rounds must be announced at least 5 minutes before starting.');
  }
  if (rStartMs < evt.scheduledStartMs || rEndMs > evt.scheduledCloseMs) {
    throw new Error('Additional round must fit entirely inside daily event hours.');
  }

  const schedule = getDailyScheduleForDateKey(
    evt.dateKey,
    evt.customRounds,
    evt.actualStartMs || evt.scheduledStartMs
  );
  for (const existing of schedule.rounds) {
    if (rStartMs < existing.endMs && rEndMs > existing.startMs) {
      throw new Error(`Additional round overlaps with existing round ${existing.label}.`);
    }
  }

  const customRound = {
    roundId: generateId(`rnd_custom_${evt.dateKey}`),
    startMs: rStartMs,
    endMs: rEndMs,
    cutoffMs: rStartMs - 3 * 60 * 1000,
    announcedAtMs: nowMs,
    adminNote
  };

  evt.customRounds.push(customRound);
  state.auditLog.push({
    auditId: generateId('aud'),
    timestampMs: nowMs,
    action: 'ADMIN_ANNOUNCE_ROUND',
    details: customRound
  });

  return customRound;
}

/**
 * Admin: Resolve a paused Automatic Elimination Checkpoint tie (Section 14).
 */
function resolveEliminationTie(state, { eliminatedStoreId, adminNote = '', nowMs = Date.now() }) {
  const evt = state.currentEvent;
  if (!evt || !evt.pendingEliminationTie) {
    throw new Error('There is no pending elimination tie to resolve.');
  }
  const tie = evt.pendingEliminationTie;
  if (!tie.candidateStoreIds.includes(eliminatedStoreId)) {
    throw new Error(`${eliminatedStoreId} is not one of the tied candidate stores (${tie.candidateStoreIds.join(', ')}).`);
  }

  const store = state.stores[eliminatedStoreId];
  store.status = 'KNOCKED_OUT';
  store.eliminatedReason = `CHECKPOINT_TIE_RESOLVED_${tie.checkpointLabel}`;
  store.eliminatedAtMs = nowMs;
  store.timesKnockedOutToday += 1;

  evt.processedCheckpoints[tie.checkpointId] = {
    processedAtMs: nowMs,
    eliminatedStoreId,
    status: 'TIE_RESOLVED_BY_ADMIN',
    adminNote
  };
  evt.pendingEliminationTie = null;

  state.combatLog.push({
    actionId: generateId('chk_tie'),
    type: 'SCHEDULED_ELIMINATION_TIE_RESOLVED',
    eventId: evt.eventId,
    checkpointId: tie.checkpointId,
    checkpointLabel: tie.checkpointLabel,
    targetId: eliminatedStoreId,
    adminNote,
    serverTimestamp: new Date(nowMs).toISOString(),
    timestampMs: nowMs
  });

  state.auditLog.push({
    auditId: generateId('aud'),
    timestampMs: nowMs,
    action: 'ADMIN_RESOLVE_ELIMINATION_TIE',
    details: {
      checkpointId: tie.checkpointId,
      eliminatedStoreId,
      candidates: tie.candidateStoreIds,
      adminNote
    }
  });

  // Re-run boundary processor in case event closing was waiting on this tie
  processScheduledBoundaries(state, nowMs);
  return state;
}

/**
 * Google Sheet Reconciliation (Sections 4 & 17):
 * - Matches records by store code (843D, 693D, 561D, 5383, 769D, 5733, 582D, 892E, 697D).
 * - Reads VL, BTS, HSI, and Acc from the source.
 * - Excludes goals, revenue, percentages, preorders, and VISA from point scoring.
 * - Prevents double credit between manual entries and later sheet updates.
 * - Detects daily sheet resets (when sheet totals reset to 0 for a new day, resets sheetBaseline without subtracting prior day earnings).
 * - Flags downward source corrections explicitly for Admin review.
 */
function reconcileSheetSnapshot(state, parsedRows, nowMs = Date.now()) {
  processScheduledBoundaries(state, nowMs);
  state.sheetSyncMeta.lastAttemptAtMs = nowMs;

  if (!Array.isArray(parsedRows) || parsedRows.length === 0) {
    return { updatedStores: 0, issuesCreated: 0 };
  }

  // Detect if the entire sheet was reset to 0 for a new day
  const totalSheetActivity = parsedRows.reduce(
    (sum, r) => sum + Number(r.vl || 0) + Number(r.bts || 0) + Number(r.hsi || 0) + parseDollarsToCents(r.acc),
    0
  );
  const previousBaselineSum = Object.values(state.stores).reduce(
    (sum, s) =>
      sum +
      Number(s.sheetBaseline.vl || 0) +
      Number(s.sheetBaseline.bts || 0) +
      Number(s.sheetBaseline.hsi || 0) +
      Number(s.sheetBaseline.accCents || 0),
    0
  );

  const isFullDailySheetReset = previousBaselineSum > 0 && totalSheetActivity === 0;
  if (isFullDailySheetReset) {
    for (const s of Object.values(state.stores)) {
      s.sheetBaseline = {
        initialized: true,
        vl: 0,
        bts: 0,
        hsi: 0,
        accCents: 0,
        classifiedBeyondFromSheetVl: 0
      };
    }
    state.auditLog.push({
      auditId: generateId('aud'),
      timestampMs: nowMs,
      action: 'SHEET_DAILY_RESET_DETECTED',
      details: { previousBaselineSum }
    });
  }

  let updatedStores = 0;
  let issuesCreated = 0;

  for (const row of parsedRows) {
    const storeId = String(row.id || '').toUpperCase();
    const store = state.stores[storeId];
    if (!store) continue;

    // Update informational non-scoring fields
    store.sheetInfo = {
      nrGoal: Number(row.nrGoal || 0),
      netRev: Number(row.netRev || 0),
      accGoal: Number(row.accGoal || 0),
      postGoal: Number(row.postGoal || 0),
      totalPP: Number(row.totalPP || 0),
      visa: Number(row.visa || 0),
      preOrders: Number(row.preOrders || 0)
    };

    const incomingVl = Math.max(0, Math.trunc(Number(row.vl || 0)));
    const incomingBts = Math.max(0, Math.trunc(Number(row.bts || 0)));
    const incomingHsi = Math.max(0, Math.trunc(Number(row.hsi || 0)));
    const incomingAccCents = Math.max(0, parseDollarsToCents(row.accCents !== undefined ? row.accCents / 100 : row.acc));

    const base = store.sheetBaseline;
    const prevVl = base.initialized ? base.vl : 0;
    const prevBts = base.initialized ? base.bts : 0;
    const prevHsi = base.initialized ? base.hsi : 0;
    const prevAccCents = base.initialized ? base.accCents : 0;

    base.initialized = true;

    // Check for downward source corrections (when not a full sheet reset)
    if (!isFullDailySheetReset) {
      if (incomingVl < prevVl || incomingBts < prevBts || incomingHsi < prevHsi || incomingAccCents < prevAccCents) {
        state.reconciliationIssues.push({
          issueId: generateId('iss'),
          type: 'DOWNWARD_CORRECTION',
          storeId,
          createdAtMs: nowMs,
          resolved: false,
          details: {
            previous: { vl: prevVl, bts: prevBts, hsi: prevHsi, accCents: prevAccCents },
            incoming: { vl: incomingVl, bts: incomingBts, hsi: incomingHsi, accCents: incomingAccCents }
          },
          description: `Sheet values for ${store.name} decreased compared to previous import. Review required before deducting points.`
        });
        issuesCreated++;
      }
    }

    // Process positive deltas while absorbing any matching unreconciledManualEntries to prevent double credit
    let deltaVl = Math.max(0, incomingVl - prevVl);
    let deltaBts = Math.max(0, incomingBts - prevBts);
    let deltaHsi = Math.max(0, incomingHsi - prevHsi);
    let deltaAccCents = Math.max(0, incomingAccCents - prevAccCents);

    if (deltaVl > 0 || deltaBts > 0 || deltaHsi > 0 || deltaAccCents > 0) {
      updatedStores++;
    }

    // Reconcile VL delta against unreconciled manual VL entries
    if (deltaVl > 0) {
      for (const mEntry of state.unreconciledManualEntries) {
        if (mEntry.storeId !== storeId || mEntry.reconciled || deltaVl <= 0) continue;
        if (mEntry.category === 'vl' && mEntry.qDelta.totalVl > 0) {
          const matched = Math.min(deltaVl, mEntry.qDelta.totalVl);
          deltaVl -= matched;
          mEntry.qDelta.totalVl -= matched;
          if (mEntry.qDelta.totalVl === 0) mEntry.reconciled = true;
        }
      }
      if (deltaVl > 0) {
        enqueueSalesEntry(state, {
          storeId,
          category: 'vl',
          qty: deltaVl,
          sourceTimestampMs: null,
          ingestedAtMs: nowMs,
          source: 'SHEET',
          note: 'Google Sheet VL import'
        });
      }
    }

    // Reconcile BTS delta against unreconciled manual watches/tablets/bts
    if (deltaBts > 0) {
      for (const mEntry of state.unreconciledManualEntries) {
        if (mEntry.storeId !== storeId || mEntry.reconciled || deltaBts <= 0) continue;
        const manualBts = (mEntry.qDelta.watches || 0) + (mEntry.qDelta.tablets || 0);
        if (manualBts > 0) {
          const matched = Math.min(deltaBts, manualBts);
          deltaBts -= matched;
          if (mEntry.qDelta.watches >= matched) {
            mEntry.qDelta.watches -= matched;
          } else {
            const rem = matched - mEntry.qDelta.watches;
            mEntry.qDelta.watches = 0;
            mEntry.qDelta.tablets = Math.max(0, mEntry.qDelta.tablets - rem);
          }
          if (mEntry.qDelta.watches + mEntry.qDelta.tablets === 0) mEntry.reconciled = true;
        }
      }
      if (deltaBts > 0) {
        enqueueSalesEntry(state, {
          storeId,
          category: 'bts',
          qty: deltaBts,
          sourceTimestampMs: null,
          ingestedAtMs: nowMs,
          source: 'SHEET',
          note: 'Google Sheet BTS import'
        });
      }
    }

    // Reconcile HSI delta
    if (deltaHsi > 0) {
      for (const mEntry of state.unreconciledManualEntries) {
        if (mEntry.storeId !== storeId || mEntry.reconciled || deltaHsi <= 0) continue;
        if (mEntry.category === 'hsi' && mEntry.qDelta.hsi > 0) {
          const matched = Math.min(deltaHsi, mEntry.qDelta.hsi);
          deltaHsi -= matched;
          mEntry.qDelta.hsi -= matched;
          if (mEntry.qDelta.hsi === 0) mEntry.reconciled = true;
        }
      }
      if (deltaHsi > 0) {
        enqueueSalesEntry(state, {
          storeId,
          category: 'hsi',
          qty: deltaHsi,
          sourceTimestampMs: null,
          ingestedAtMs: nowMs,
          source: 'SHEET',
          note: 'Google Sheet HSI import'
        });
      }
    }

    // Reconcile Accessories Cents delta
    if (deltaAccCents > 0) {
      for (const mEntry of state.unreconciledManualEntries) {
        if (mEntry.storeId !== storeId || mEntry.reconciled || deltaAccCents <= 0) continue;
        if ((mEntry.category === 'acc' || mEntry.category === 'accCents') && mEntry.qDelta.accCents > 0) {
          const matched = Math.min(deltaAccCents, mEntry.qDelta.accCents);
          deltaAccCents -= matched;
          mEntry.qDelta.accCents -= matched;
          if (mEntry.qDelta.accCents === 0) mEntry.reconciled = true;
        }
      }
      if (deltaAccCents > 0) {
        enqueueSalesEntry(state, {
          storeId,
          category: 'accCents',
          accCents: deltaAccCents,
          sourceTimestampMs: null,
          ingestedAtMs: nowMs,
          source: 'SHEET',
          note: `Google Sheet Accessories import (${formatCentsToDollars(deltaAccCents)})`
        });
      }
    }

    // Advance baseline for non-decreasing values
    base.vl = Math.max(prevVl, incomingVl);
    base.bts = Math.max(prevBts, incomingBts);
    base.hsi = Math.max(prevHsi, incomingHsi);
    base.accCents = Math.max(prevAccCents, incomingAccCents);
  }

  state.sheetSyncMeta.lastSuccessAtMs = nowMs;
  state.sheetSyncMeta.importCount += 1;
  state.sheetSyncMeta.lastError = null;

  // Re-run boundaries in case event is in pre-start or at a cutoff
  processScheduledBoundaries(state, nowMs);
  return { updatedStores, issuesCreated };
}

module.exports = {
  OFFICIAL_ROSTER,
  SCHEMA_VERSION,
  generateId,
  createStoreDailyState,
  createInitialDatabaseState,
  isEventDayEnabled,
  syncStoreDerivedTotals,
  syncWeeklyLedgerFromDailyEvent,
  getWeeklyStandings,
  initializeDailyEventForDate,
  performWeeklyRollover,
  enqueueSalesEntry,
  releasePendingSalesUpToCutoff,
  processPowerPhaseEntry,
  processEliminationCheckpoint,
  openBattleRound,
  closeBattleRound,
  finalizeDailyClosing,
  processScheduledBoundaries,
  startDailyEvent,
  executeAttack,
  executeRevival,
  purchaseShield,
  announceCustomRound,
  resolveEliminationTie,
  reconcileSheetSnapshot
};
