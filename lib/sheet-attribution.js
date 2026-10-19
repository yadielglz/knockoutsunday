'use strict';

// A sheet snapshot is evidence of sales even when no combat event is open.
// Closed-day catch-up updates earnings/history, never replays combat or awards qualifiers.
const crypto = require('node:crypto');
const { getEasternParts, getWeeklyPeriodForTimestamp, getDailyScheduleForDateKey } = require('./time');
const { calculateSalesPointsBp, parseDollarsToCents } = require('./scoring');
const { OFFICIAL_ROSTER, createInitialDatabaseState, syncStoreDerivedTotals, getWeeklyStandings } = require('./engine');

function normalizeRows(rows) {
  return rows.filter(r => OFFICIAL_ROSTER.some(s => s.id === String(r.id).toUpperCase())).map(r => ({
    ...r, id: String(r.id).toUpperCase(), vl: Math.max(0, Math.trunc(Number(r.vl || 0))),
    bts: Math.max(0, Math.trunc(Number(r.bts || 0))), hsi: Math.max(0, Math.trunc(Number(r.hsi || 0))),
    accCents: Math.max(0, r.accCents === undefined ? parseDollarsToCents(r.acc || 0) : Math.trunc(r.accCents))
  })).sort((a,b) => a.id.localeCompare(b.id));
}
function reportDate(state, rows, nowMs, explicitDate) {
  if (explicitDate) {
    const schedule = getDailyScheduleForDateKey(explicitDate);
    if (getEasternParts(schedule.scheduledStartMs).dateKey !== explicitDate) throw new Error('Invalid sheet report date');
    if (explicitDate > getEasternParts(nowMs).dateKey) throw new Error('Sheet report date is in the future');
    return explicitDate;
  }
  const today = getEasternParts(nowMs).dateKey;
  const last = state.latestSheetReport;
  if (!last || today <= last.dateKey) return today;
  // Undated unchanged sheets remain on their observed reporting date overnight.
  // A counter reset/decrease on a later day is evidence of a new daily report.
  const reset = rows.some(r => {
    const old = last.rows.find(o => o.id === r.id);
    return old && ['vl','bts','hsi','accCents'].some(k => r[k] < old[k]);
  });
  const wasEmpty = last.rows.every(r => ['vl','bts','hsi','accCents'].every(k => !r[k]));
  return reset || wasEmpty ? today : last.dateKey;
}
function getWeek(state, period, nowMs) {
  if (state.currentWeek.weekId === period.weekId) return state.currentWeek;
  let week = state.weeklyArchives.find(w => w.weekId === period.weekId);
  if (!week) {
    const initial = createInitialDatabaseState(period.startMs + 86400000);
    week = { ...initial.currentWeek, ...period, archivedAtMs: nowMs, recoveredFromSheet: true };
    state.weeklyArchives.push(week);
  }
  return week;
}
function recomputeWeek(week, state) {
  for (const ledger of Object.values(week.weeklyStoreLedger)) {
    const days = Object.entries(ledger.dailyBreakdown).filter(([date]) => enabled(state,date));
    ledger.cumulativeSalesEarnedBp = days.reduce((n,[,d]) => n + d.salesEarnedBp,0);
    ledger.cumulativeAdminBonusBp = days.reduce((n,[,d]) => n + d.adminBonusBp,0);
    ledger.cumulativeEarnedBp = ledger.cumulativeSalesEarnedBp + ledger.cumulativeAdminBonusBp;
  }
  if (week !== state.currentWeek) week.finalStandings = getWeeklyStandings({ ...state, currentWeek: week, currentEvent: null }).standings;
}
function enabled(state,date) {
  if (typeof state.enabledDateOverrides?.[date] === 'boolean') return state.enabledDateOverrides[date];
  return state.enabledWeekdays[getDailyScheduleForDateKey(date).weekdayShort] !== false;
}
function applyClosedReport(state, report, nowMs) {
  const schedule = getDailyScheduleForDateKey(report.dateKey);
  const period = getWeeklyPeriodForTimestamp(schedule.scheduledStartMs);
  const week = getWeek(state,period,nowMs);
  const current = state.currentEvent?.dateKey === report.dateKey;
  const archive = state.dailyArchives.find(a => a.dateKey === report.dateKey);
  const targetStores = current ? state.stores : archive?.finalStoresSnapshot;
  const isEnabled = enabled(state,report.dateKey);
  for (const row of report.rows) {
    const store = targetStores?.[row.id];
    // Retain manual sales not matched to the source; never add matched manual sales twice.
    const extras = { totalVl:0, watches:0, tablets:0, hsi:0, accCents:0 };
    const baseline = store?.sheetBaseline || {};
    const remaining = {totalVl:Math.max(0,row.vl-(baseline.vl||0)),
      watches:Math.max(0,row.bts-(baseline.bts||0)),tablets:0,
      hsi:Math.max(0,row.hsi-(baseline.hsi||0)),accCents:Math.max(0,row.accCents-(baseline.accCents||0))};
    if (current) for (const m of state.unreconciledManualEntries || []) {
      if (m.storeId !== row.id || m.reconciled || getEasternParts(m.createdAtMs).dateKey !== report.dateKey) continue;
      for (const k of Object.keys(extras)) {
        const sourceKey = k === 'tablets' ? 'watches' : k;
        const matched = Math.min(remaining[sourceKey],Math.max(0,Number(m.qDelta[k]||0)));
        remaining[sourceKey] -= matched;
        m.qDelta[k] = Number(m.qDelta[k]||0)-matched;
        extras[k] += m.qDelta[k];
      }
      if (Object.keys(extras).every(k => !m.qDelta[k])) m.reconciled = true;
    }
    const quantities = { totalVl:row.vl+extras.totalVl, watches:row.bts+extras.watches,
      tablets:extras.tablets, hsi:row.hsi+extras.hsi, accCents:row.accCents+extras.accCents };
    quantities.bts = quantities.watches + quantities.tablets;
    const calc = calculateSalesPointsBp({ ...quantities, bts:quantities.bts });
    const ledger = week.weeklyStoreLedger[row.id];
    const prior = ledger.dailyBreakdown[report.dateKey];
    const adminBonusBp = store?.adminBonusBp ?? prior?.adminBonusBp ?? 0;
    if (isEnabled) ledger.dailyBreakdown[report.dateKey] = {
      ...prior, salesEarnedBp:calc.totalSalesBp, adminBonusBp,
      totalDailyEarnedBp:calc.totalSalesBp+adminBonusBp,
      qualified: prior?.qualified || week.dailyQualifiersByDate[report.dateKey]?.includes(row.id) || false,
      source:'AUTOMATIC_SHEET_CATCHUP', correctedAtMs:nowMs
    };
    if (store) {
      const before = store.salesEarnedBp;
      store.quantities = quantities;
      store.pendingQuantities = { totalVl:0,watches:0,tablets:0,bts:0,hsi:0,accCents:0 };
      syncStoreDerivedTotals(store);
      store.availableBp = Math.max(0,store.availableBp + store.salesEarnedBp-before);
      store.sheetBaseline = { initialized:true, vl:row.vl,bts:row.bts,hsi:row.hsi,accCents:row.accCents };
      if (archive?.finalStoresSnapshot) archive.finalStoresSnapshot[row.id] = structuredClone(store);
    }
  }
  if (isEnabled && !week.countedDaysHeld.includes(report.dateKey)) week.countedDaysHeld.push(report.dateKey);
  // Remove the same day's accidental attribution to a different Sunday week.
  if (week !== state.currentWeek) {
    for (const ledger of Object.values(state.currentWeek.weeklyStoreLedger)) delete ledger.dailyBreakdown[report.dateKey];
    state.currentWeek.countedDaysHeld = state.currentWeek.countedDaysHeld.filter(d => d !== report.dateKey);
    delete state.currentWeek.dailyQualifiersByDate[report.dateKey];
    recomputeWeek(state.currentWeek,state);
  }
  if (current) state.currentEvent.weekId = period.weekId;
  if (archive) archive.weekId = period.weekId;
  for (const issue of state.reconciliationIssues) {
    if (!issue.resolved && issue.source === 'SHEET' && issue.type === 'LATE_CROSS_BOUNDARY_SALE' &&
        getEasternParts(issue.ingestedAtMs).dateKey === report.dateKey) {
      issue.resolved = true; issue.resolvedAtMs = nowMs;
      issue.resolution = 'AUTOMATIC_SHEET_REPORT_DATE'; issue.attributedDateKey = report.dateKey;
    }
  }
  if (current) for (const sale of state.pendingSalesQueue) {
    if (sale.status === 'PENDING' && getEasternParts(sale.ingestedAtMs).dateKey === report.dateKey) {
      sale.releasedAtMs = nowMs; sale.status = 'RELEASED'; sale.releasedAtCutoffKey = 'CLOSED_EVENT_SHEET_SETTLEMENT';
      const log = state.salesLog.find(s => s.saleId === sale.saleId);
      if (log) Object.assign(log,{status:sale.status,releasedAtMs:nowMs,releasedAtCutoffKey:sale.releasedAtCutoffKey});
    }
  }
  recomputeWeek(week,state);
  report.weekId = period.weekId;
  report.status = isEnabled ? 'RECORDED_IN_EVENT_WEEK' : 'RECORDED_DISABLED_DAY';
  state.auditLog.push({ auditId:'sheet_'+report.contentHash+'_'+report.dateKey,
    timestampMs:nowMs,action:'AUTOMATIC_SHEET_REPORT_ATTRIBUTION',
    details:{dateKey:report.dateKey,weekId:period.weekId,combatReplayed:false} });
}
function reconcileDatedSheetSnapshot(state, inputRows, nowMs, reconcileLive, explicitDate) {
  require('./engine').processScheduledBoundaries(state,nowMs);
  const rows = normalizeRows(inputRows);
  for (const r of rows) r.sheetEarnedPoints = calculateSalesPointsBp({totalVl:r.vl,bts:r.bts,hsi:r.hsi,accCents:r.accCents}).totalSalesPoints;
  if (!rows.length || new Set(rows.map(r => r.id)).size !== rows.length) {
    throw new Error('Sheet import must contain unique recognized district stores. Existing balances were preserved.');
  }
  const dateKey = reportDate(state,rows,nowMs,explicitDate || inputRows.reportDateKey);
  const contentHash = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  state.sheetReports ||= {};
  const previous = state.sheetReports[dateKey];
  const report = { dateKey, rows, contentHash, importedAtMs:nowMs,
    attribution:explicitDate || inputRows.reportDateKey ? 'EXPLICIT_SHEET_DATE' : 'OBSERVED_EASTERN_REPORT_DAY' };
  const schedule = getDailyScheduleForDateKey(dateKey);
  const closed = nowMs >= schedule.eventCloseMs || (state.currentEvent?.dateKey === dateKey && ['ENDED_DRAW','ENDED_NORMAL'].includes(state.currentEvent.status));
  let liveResult = {};
  if (closed) {
    if (!previous || previous.contentHash !== contentHash || previous.status === 'PENDING_CUTOFF') applyClosedReport(state,report,nowMs);
    else Object.assign(report,{status:previous.status,weekId:previous.weekId});
    state.sheetSyncMeta.lastAttemptAtMs=nowMs;state.sheetSyncMeta.lastSuccessAtMs=nowMs;
    state.sheetSyncMeta.lastError=null;state.sheetSyncMeta.importCount++;
  } else {
    if (state.currentEvent?.dateKey !== dateKey) throw new Error('Sheet date does not match the active reporting event.');
    liveResult = reconcileLive(state,rows,nowMs);
    report.status='PENDING_CUTOFF';
    report.weekId=getWeeklyPeriodForTimestamp(schedule.scheduledStartMs).weekId;
  }
  state.sheetReports[dateKey]=report;
  state.latestSheetReport=report;
  return { updatedStores:closed ? rows.length : liveResult.updatedStores, issuesCreated:liveResult.issuesCreated || 0, dateKey, weekId:report.weekId, status:report.status };
}
module.exports={reconcileDatedSheetSnapshot};
