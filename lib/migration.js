/**
 * Knockout Blitz — Versioned Schema Migration (v1 -> v2)
 * Implements Section 19:
 * - Preserves a recoverable backup of v1 data.
 * - Recalculates sales-derived points from quantities where possible.
 * - Converts legacy point-only adjustments (bonusPts) once where appropriate.
 * - Never multiplies accessory dollar amounts or sales quantities.
 * - Flags legacy direct-knockout combat logs for admin review without reinterpreting them as damage combat.
 */

const {
  SCHEMA_VERSION,
  createInitialDatabaseState,
  syncStoreDerivedTotals,
  syncWeeklyLedgerFromDailyEvent,
  generateId
} = require('./engine');
const {
  BP_PER_POINT,
  POINTS_CONFIG,
  parseDollarsToCents,
  calculateSalesPointsBp
} = require('./scoring');

const LEGACY_POINT_CONVERSION_FACTOR = 200; // 1 legacy point = 200 Knockout Blitz points

function needsMigration(rawState) {
  if (!rawState || typeof rawState !== 'object') return false;
  return !rawState.schemaVersion || Number(rawState.schemaVersion) < SCHEMA_VERSION;
}

function migrateV1ToV2(v1State, nowMs = Date.now()) {
  if (!needsMigration(v1State)) {
    return v1State;
  }

  const backupCopy = JSON.parse(JSON.stringify(v1State));
  const v2 = createInitialDatabaseState(nowMs);

  if (v1State.districtName) {
    v2.districtName = v1State.districtName;
  }
  if (v1State.announcement && typeof v1State.announcement === 'object') {
    v2.announcement = { ...v1State.announcement };
  }
  if (v1State.settings?.sheetUrl) {
    v2.sheetSyncMeta.sheetUrl = v1State.settings.sheetUrl;
  }

  const flaggedLegacyRecords = [];

  // Migrate manualLines per store by recalculating points from quantities
  const manualLines = v1State.manualLines || {};
  for (const [storeId, m] of Object.entries(manualLines)) {
    const store = v2.stores[storeId];
    if (!store || !m || typeof m !== 'object') continue;

    const vl = Math.max(0, Math.trunc(Number(m.vl || 0))) + Math.max(0, Math.trunc(Number(m.beyondVl || 0)));
    const watches = Math.max(0, Math.trunc(Number(m.watches || 0)));
    const tablets = Math.max(0, Math.trunc(Number(m.tablets || 0)));
    const bts = watches + tablets;
    const hsi = Math.max(0, Math.trunc(Number(m.hsi || 0)));
    // Never multiply accessory dollar amounts — convert dollars directly to cents
    const accCents = Math.max(0, parseDollarsToCents(m.acc || 0));

    store.quantities.totalVl = vl;
    store.quantities.watches = watches;
    store.quantities.tablets = tablets;
    store.quantities.bts = bts;
    store.quantities.hsi = hsi;
    store.quantities.accCents = accCents;

    // Convert legacy point-only bonusPts adjustment once (1 legacy pt -> 200 pts)
    const legacyBonusPts = Number(m.bonusPts || 0);
    if (legacyBonusPts !== 0) {
      const convertedBonusBp = Math.round(legacyBonusPts * LEGACY_POINT_CONVERSION_FACTOR * BP_PER_POINT);
      store.adminBonusBp = convertedBonusBp;
      v2.auditLog.push({
        auditId: generateId('aud_mig'),
        timestampMs: nowMs,
        action: 'MIGRATED_LEGACY_BONUS_POINTS',
        details: {
          storeId,
          legacyBonusPts,
          convertedBonusPoints: legacyBonusPts * LEGACY_POINT_CONVERSION_FACTOR
        }
      });
    }

    syncStoreDerivedTotals(store);
    store.availableBp = Math.max(0, store.carriedOpeningBalanceBp + store.salesEarnedBp + store.adminBonusBp);

    // Record unreconciled manual entry so subsequent sheet import doesn't double-credit
    if (vl > 0 || watches > 0 || tablets > 0 || hsi > 0 || accCents > 0) {
      if (vl > 0) {
        v2.unreconciledManualEntries.push({
          entryId: generateId('mig_vl'),
          storeId,
          category: 'vl',
          qDelta: { totalVl: vl, watches: 0, tablets: 0, hsi: 0, accCents: 0 },
          createdAtMs: nowMs,
          note: 'Migrated from v1 manualLines',
          reconciled: false
        });
      }
      if (watches > 0 || tablets > 0) {
        v2.unreconciledManualEntries.push({
          entryId: generateId('mig_bts'),
          storeId,
          category: 'watches',
          qDelta: { totalVl: 0, watches, tablets, hsi: 0, accCents: 0 },
          createdAtMs: nowMs,
          note: 'Migrated from v1 manualLines',
          reconciled: false
        });
      }
      if (hsi > 0) {
        v2.unreconciledManualEntries.push({
          entryId: generateId('mig_hsi'),
          storeId,
          category: 'hsi',
          qDelta: { totalVl: 0, watches: 0, tablets: 0, hsi, accCents: 0 },
          createdAtMs: nowMs,
          note: 'Migrated from v1 manualLines',
          reconciled: false
        });
      }
      if (accCents > 0) {
        v2.unreconciledManualEntries.push({
          entryId: generateId('mig_acc'),
          storeId,
          category: 'accCents',
          qDelta: { totalVl: 0, watches: 0, tablets: 0, hsi: 0, accCents },
          createdAtMs: nowMs,
          note: 'Migrated from v1 manualLines',
          reconciled: false
        });
      }
    }
  }

  // Flag legacy direct-knockout combatLog entries without reinterpreting them as 400-damage combat
  if (Array.isArray(v1State.combatLog) && v1State.combatLog.length > 0) {
    for (const legacyEvt of v1State.combatLog) {
      flaggedLegacyRecords.push({
        flagId: generateId('flg'),
        reason: 'LEGACY_V1_DIRECT_KNOCKOUT_RECORD',
        description:
          'Legacy v1 1-point direct knockout/revive event preserved for Admin review; not reinterpreted as v2 damage combat.',
        record: legacyEvt
      });
    }
  }

  // Flag any custom non-roster stores from v1
  if (Array.isArray(v1State.customStores) && v1State.customStores.length > 0) {
    for (const cs of v1State.customStores) {
      flaggedLegacyRecords.push({
        flagId: generateId('flg_store'),
        reason: 'LEGACY_CUSTOM_STORE',
        description: 'Custom store from v1 flagged for Admin review.',
        record: cs
      });
    }
  }

  syncWeeklyLedgerFromDailyEvent(v2);

  v2.migrationMeta = {
    migratedFromV1At: new Date(nowMs).toISOString(),
    previousVersion: v1State.version || 1,
    flaggedLegacyRecords,
    legacyBackup: backupCopy
  };

  v2.auditLog.push({
    auditId: generateId('aud_mig'),
    timestampMs: nowMs,
    action: 'SCHEMA_MIGRATED_V1_TO_V2',
    details: {
      flaggedRecordsCount: flaggedLegacyRecords.length
    }
  });

  return v2;
}

module.exports = {
  LEGACY_POINT_CONVERSION_FACTOR,
  needsMigration,
  migrateV1ToV2
};
