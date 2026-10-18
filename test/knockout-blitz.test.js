'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const time = require('../lib/time');
const scoring = require('../lib/scoring');
const auth = require('../lib/auth');
const engine = require('../lib/engine');
const migration = require('../lib/migration');
const storage = require('../lib/storage');
const { handleApiRequest } = require('../lib/api-handler');

// ---------------------------------------------------------------------------
// 1. BRANDING, ROSTER & SCORING (Sections 1 & 4)
// ---------------------------------------------------------------------------
test('Section 1 & 4: Official 9-store roster, fixed-precision point scoring, HINT = 600, and +300 bonus per 300 sales points', () => {
  assert.equal(engine.OFFICIAL_ROSTER.length, 9);
  const expectedIds = ['843D', '693D', '561D', '5383', '769D', '5733', '582D', '892E', '697D'];
  assert.deepEqual(engine.OFFICIAL_ROSTER.map((s) => s.id), expectedIds);

  // Accessories examples: $25 = 50 pts, $50 = 100 pts, $100 = 200 pts (all < 300 base sales pts, so 0 milestone bonus)
  assert.equal(scoring.calculateSalesPointsBp({ accCents: scoring.parseDollarsToCents(25) }).totalSalesPoints, 50);
  assert.equal(scoring.calculateSalesPointsBp({ accCents: scoring.parseDollarsToCents(50) }).totalSalesPoints, 100);
  assert.equal(scoring.calculateSalesPointsBp({ accCents: scoring.parseDollarsToCents(100) }).totalSalesPoints, 200);

  // $200 accessories = 400 base sales pts -> crosses 300 milestone once (+300 bonus) = 700 total sales pts!
  const acc200 = scoring.calculateSalesPointsBp({ accCents: scoring.parseDollarsToCents(200) });
  assert.equal(acc200.baseSalesPoints, 400);
  assert.equal(acc200.milestoneCount, 1);
  assert.equal(acc200.milestoneBonusPoints, 300);
  assert.equal(acc200.totalSalesPoints, 700);

  // Fractional cents precision: $10.25 = 1025 cents = 2050 bp = 20.50 points (no floating-point drift)
  const calc1025 = scoring.calculateSalesPointsBp({ accCents: scoring.parseDollarsToCents('10.25') });
  assert.equal(calc1025.totalSalesBp, 2050);
  assert.equal(calc1025.totalSalesPoints, 20.5);
  assert.equal(scoring.formatBp(calc1025.totalSalesBp), '20.5');

  // 1 HINT (HSI) = 600 base sales pts -> crosses two 300-pt milestones (2 * 300 = +600 bonus) = 1,200 total sales pts!
  const calcHsi = scoring.calculateSalesPointsBp({ hsi: 1 });
  assert.equal(calcHsi.baseSalesPoints, 600);
  assert.equal(calcHsi.milestoneCount, 2);
  assert.equal(calcHsi.milestoneBonusPoints, 600);
  assert.equal(calcHsi.totalSalesPoints, 1200);

  // Standard categories combined:
  // 2 VL (400) + 3 BTS (600) + 1 HSI (600) + $25 Acc (50) = 1,650 base sales pts
  // Floor(1650 / 300) = 5 milestones * 300 = +1,500 bonus pts -> 3,150 total sales pts!
  const calcAll = scoring.calculateSalesPointsBp({
    totalVl: 2,    // 400 pts
    bts: 3,        // 1 watch + 2 tablets = 600 pts
    hsi: 1,        // 600 pts
    accCents: 2500 // $25 = 50 pts
  });
  assert.equal(calcAll.baseSalesPoints, 1650);
  assert.equal(calcAll.milestoneCount, 5);
  assert.equal(calcAll.milestoneBonusPoints, 1500);
  assert.equal(calcAll.totalSalesPoints, 3150);
});

test('Section 4: Sales milestone bonus (+300 per 300 sales points) triggers across incremental sales and rejects removed Beyond VL', () => {
  // 1 VL = 200 base pts (< 300 -> 0 bonus -> 200 total)
  const step1 = scoring.calculateSalesPointsBp({ totalVl: 1 });
  assert.equal(step1.baseSalesPoints, 200);
  assert.equal(step1.milestoneBonusPoints, 0);
  assert.equal(step1.totalSalesPoints, 200);

  // Add $50 accessories (+100 base pts) -> 300 base pts -> triggers +300 bonus -> 600 total!
  const step2 = scoring.calculateSalesPointsBp({ totalVl: 1, accCents: 5000 });
  assert.equal(step2.baseSalesPoints, 300);
  assert.equal(step2.milestoneBonusPoints, 300);
  assert.equal(step2.totalSalesPoints, 600);

  // Beyond VL mechanic is completely removed from enqueueSalesEntry
  const startMs = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 0, 0);
  const state = engine.createInitialDatabaseState(startMs);
  assert.throws(() => {
    engine.enqueueSalesEntry(state, { storeId: '843D', category: 'beyondVl_standalone', qty: 1, ingestedAtMs: startMs });
  }, /Unsupported sales category/);
});

// ---------------------------------------------------------------------------
// 2. TIMEZONE, SCHEDULES, ROUNDS, CUTOFFS & DST (Sections 2, 3, 7, 8)
// ---------------------------------------------------------------------------
test('Section 2 & 3: America/New_York schedules for Mon-Sat vs Sunday and Weekly Period [Sun 7PM, next Sun 7PM)', () => {
  // Weekday: Monday 2026-10-19
  const monSched = time.getDailyScheduleForDateKey('2026-10-19');
  assert.equal(monSched.isSunday, false);
  assert.equal(time.getEasternParts(monSched.scheduledStartMs).hour, 11);
  assert.equal(time.getEasternParts(monSched.scheduledStartMs).minute, 0);
  assert.equal(time.getEasternParts(monSched.finalStretchStartMs).hour, 17);
  assert.equal(time.getEasternParts(monSched.finalStretchStartMs).minute, 45);
  assert.equal(time.getEasternParts(monSched.powerPhaseStartMs).hour, 17);
  assert.equal(time.getEasternParts(monSched.powerPhaseStartMs).minute, 45);
  assert.equal(time.getEasternParts(monSched.eventCloseMs).hour, 20);
  assert.equal(time.getEasternParts(monSched.eventCloseMs).minute, 45);
  // Power phase duration on Mon-Sat is 3 hours (180 mins)
  assert.equal((monSched.eventCloseMs - monSched.powerPhaseStartMs) / 60000, 180);

  // First round Mon-Sat: 11:10–11:15 AM (cutoff 11:07 AM)
  // Final round Mon-Sat: 8:30–8:35 PM (cutoff 8:27 PM)
  assert.equal(monSched.rounds[0].label, '11:10 AM–11:15 AM');
  assert.equal(time.formatEasternTimeLabel(monSched.rounds[0].cutoffMs), '11:07 AM');
  const lastMonRound = monSched.rounds[monSched.rounds.length - 1];
  assert.equal(lastMonRound.label, '8:30 PM–8:35 PM');
  assert.equal(time.formatEasternTimeLabel(lastMonRound.cutoffMs), '8:27 PM');

  // Mon-Sat Checkpoints: 6:15, 6:45, 7:15, 7:45, 8:15, 8:45 PM
  assert.deepEqual(
    monSched.eliminationCheckpoints.map((c) => c.label),
    ['6:15 PM', '6:45 PM', '7:15 PM', '7:45 PM', '8:15 PM', '8:45 PM']
  );

  // Sunday Exception: Sunday 2026-10-18
  const sunSched = time.getDailyScheduleForDateKey('2026-10-18');
  assert.equal(sunSched.isSunday, true);
  assert.equal(time.getEasternParts(sunSched.scheduledStartMs).hour, 13); // 1:00 PM
  assert.equal(time.getEasternParts(sunSched.finalStretchStartMs).hour, 15); // 3:45 PM
  assert.equal(time.getEasternParts(sunSched.finalStretchStartMs).minute, 45);
  assert.equal(time.getEasternParts(sunSched.powerPhaseStartMs).hour, 16); // 4:45 PM
  assert.equal(time.getEasternParts(sunSched.powerPhaseStartMs).minute, 45);
  assert.equal(time.getEasternParts(sunSched.eventCloseMs).hour, 17); // 5:45 PM
  assert.equal(time.getEasternParts(sunSched.eventCloseMs).minute, 45);
  // Sunday final stretch is 2 hours, Power phase is 1 hour
  assert.equal((sunSched.eventCloseMs - sunSched.finalStretchStartMs) / 60000, 120);
  assert.equal((sunSched.eventCloseMs - sunSched.powerPhaseStartMs) / 60000, 60);

  // First round Sunday: 1:10–1:15 PM; Final round Sunday: 5:30–5:35 PM
  assert.equal(sunSched.rounds[0].label, '1:10 PM–1:15 PM');
  assert.equal(sunSched.rounds[sunSched.rounds.length - 1].label, '5:30 PM–5:35 PM');

  // Sunday Checkpoints: 4:15, 4:45, 5:15, 5:45 PM
  assert.deepEqual(
    sunSched.eliminationCheckpoints.map((c) => c.label),
    ['4:15 PM', '4:45 PM', '5:15 PM', '5:45 PM']
  );

  // Sunday daytime event ownership (e.g., Sunday 2026-10-18 at 2:00 PM ET belongs to week ending 2026-10-18 at 7:00 PM ET)
  const sunDaytimeMs = time.easternWallTimeToEpochMs(2026, 10, 18, 14, 0, 0);
  const sunRolloverMs = time.easternWallTimeToEpochMs(2026, 10, 18, 19, 0, 0);
  const periodBefore7Pm = time.getWeeklyPeriodForTimestamp(sunDaytimeMs);
  const periodAt7Pm = time.getWeeklyPeriodForTimestamp(sunRolloverMs);

  assert.equal(periodBefore7Pm.weekId, 'week_2026-10-11_to_2026-10-18');
  assert.equal(periodBefore7Pm.nextStartMs, sunRolloverMs);
  assert.equal(periodAt7Pm.weekId, 'week_2026-10-18_to_2026-10-25');
  assert.equal(periodAt7Pm.startMs, sunRolloverMs);
});

test('Section 2: Eastern Daylight Saving Time (EDT <-> EST) boundary handling', () => {
  // Spring Forward: Sunday March 8, 2026
  const beforeSpringDst = time.easternWallTimeToEpochMs(2026, 3, 7, 19, 0, 0); // EST (UTC-5)
  const afterSpringDst = time.easternWallTimeToEpochMs(2026, 3, 8, 19, 0, 0);  // EDT (UTC-4)
  assert.equal((afterSpringDst - beforeSpringDst) / 3600000, 23); // 23 hours elapsed between 7 PM Sat and 7 PM Sun

  // Fall Back: Sunday November 1, 2026
  const beforeFallDst = time.easternWallTimeToEpochMs(2026, 10, 31, 19, 0, 0); // EDT (UTC-4)
  const afterFallDst = time.easternWallTimeToEpochMs(2026, 11, 1, 19, 0, 0);   // EST (UTC-5)
  assert.equal((afterFallDst - beforeFallDst) / 3600000, 25); // 25 hours elapsed between 7 PM Sat and 7 PM Sun
});

// ---------------------------------------------------------------------------
// 3. CUTOFFS, PENDING POINTS & SHEET RECONCILIATION (Sections 8 & 16)
// ---------------------------------------------------------------------------
test('Section 8: :07, :27, :47 three-minute cutoffs, pending point release (with +300 milestone bonus), and closing preservation', () => {
  const monDate = '2026-10-19';
  const startMs = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 0, 0);
  let state = engine.createInitialDatabaseState(startMs);
  engine.startDailyEvent(state, startMs, true);

  // Sale logged at 11:05 AM (before 11:07 AM cutoff for 11:10 AM round) -> initially PENDING
  // 2 VLs = 400 base sales pts + 300 milestone bonus = 700 pts!
  const sale1Ms = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 5, 0);
  engine.enqueueSalesEntry(state, {
    storeId: '843D',
    category: 'vl',
    qty: 2,
    ingestedAtMs: sale1Ms
  });

  let store = state.stores['843D'];
  assert.equal(scoring.bpToPoints(store.pendingBp), 700);
  assert.equal(scoring.bpToPoints(store.availableBp), 0);

  // Process up to 11:07 AM cutoff -> sale1 is released into availableBp (700 pts)!
  const cutoff1Ms = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 7, 0);
  engine.processScheduledBoundaries(state, cutoff1Ms);
  assert.equal(scoring.bpToPoints(store.pendingBp), 0);
  assert.equal(scoring.bpToPoints(store.availableBp), 700);
  assert.equal(scoring.bpToPoints(store.salesEarnedBp), 700);

  // Sale logged at 11:08 AM (AFTER 11:07 AM cutoff) -> remains PENDING during the 11:10 AM round!
  // 1 HSI = 600 base pts. Combined base pts = 400 + 600 = 1,000 -> 3 milestones (900 bonus) -> 1,900 total (so +1,200 pending!)
  const sale2Ms = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 8, 0);
  engine.enqueueSalesEntry(state, {
    storeId: '843D',
    category: 'hsi',
    qty: 1,
    ingestedAtMs: sale2Ms
  });

  const round1StartMs = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 10, 0);
  engine.processScheduledBoundaries(state, round1StartMs);
  assert.equal(state.currentEvent.activeRoundId, `rnd_${monDate}_1110`);
  assert.equal(scoring.bpToPoints(store.pendingBp), 1200);
  assert.equal(scoring.bpToPoints(store.availableBp), 700); // Still 700, not 1900

  // At 11:27 AM cutoff for 11:30 AM round -> sale2 is released!
  const cutoff2Ms = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 27, 0);
  engine.processScheduledBoundaries(state, cutoff2Ms);
  assert.equal(scoring.bpToPoints(store.pendingBp), 0);
  assert.equal(scoring.bpToPoints(store.availableBp), 1900);

  // Sale logged at 8:30 PM (after final 8:27 PM cutoff): +1 Watch (200 base pts)
  // Combined base pts = 1,000 + 200 = 1,200 -> crosses 4th milestone (+300 bonus) -> +500 pending pts preserved at 8:45 PM closing!
  const lateSaleMs = time.easternWallTimeToEpochMs(2026, 10, 19, 20, 30, 0);
  engine.enqueueSalesEntry(state, {
    storeId: '843D',
    category: 'watches',
    qty: 1,
    ingestedAtMs: lateSaleMs
  });
  const endMs = time.easternWallTimeToEpochMs(2026, 10, 19, 20, 45, 0);
  engine.processScheduledBoundaries(state, endMs);
  assert.equal(state.currentEvent.status, 'ENDED_NORMAL');
  assert.equal(scoring.bpToPoints(store.pendingBp), 500);
});

test('Section 16: Sheet reconciliation — repeat imports, manual matching, downward corrections, and cross-boundary quarantine', () => {
  const preStartMs = time.easternWallTimeToEpochMs(2026, 10, 19, 10, 50, 0); // Before 11:00 AM start
  const eventStartMs = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 0, 0);
  let state = engine.createInitialDatabaseState(preStartMs);

  // 1. Admin logs a manual VL sale (1 VL = 200 base pts) and $50 accessories (100 base pts) before start
  // Combined base sales = 300 pts -> +300 milestone bonus = 600 total pts!
  engine.enqueueSalesEntry(state, {
    storeId: '843D',
    category: 'vl',
    qty: 1,
    ingestedAtMs: preStartMs,
    source: 'MANUAL'
  });
  engine.enqueueSalesEntry(state, {
    storeId: '843D',
    category: 'acc',
    qty: 50, // $50 = 100 pts
    ingestedAtMs: preStartMs,
    source: 'MANUAL'
  });

  // Start event at 11:00 AM -> releases pre-start sales (300 base + 300 milestone = 600 pts)
  engine.startDailyEvent(state, eventStartMs, false);
  assert.equal(scoring.bpToPoints(state.stores['843D'].availableBp), 600);

  // 2. Sheet import arrives at 11:05 AM with 2 VLs and $50 accessories for 843D.
  // Because 1 manual VL and $50 manual accessories were logged today, reconcileSheetSnapshot
  // matches them to the sheet so they are NOT double-counted! Only +1 new VL (200 pts) is enqueued,
  // and released at 11:07 AM cutoff -> total becomes 500 base + 300 bonus = 800 pts!
  const sheetRows1 = [
    { id: '843D', vl: 2, bts: 0, hsi: 0, acc: 50 }
  ];
  const sync1 = engine.reconcileSheetSnapshot(state, sheetRows1, eventStartMs + 5 * 60000);
  assert.equal(sync1.updatedStores, 1);

  const cutoff1107Ms = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 7, 0);
  engine.processScheduledBoundaries(state, cutoff1107Ms);
  assert.equal(scoring.bpToPoints(state.stores['843D'].availableBp), 800);

  // 3. Repeat import of identical sheet snapshot is a no-op (idempotent)
  const sync2 = engine.reconcileSheetSnapshot(state, sheetRows1, cutoff1107Ms + 1000);
  assert.equal(sync2.updatedStores, 0);
  assert.equal(scoring.bpToPoints(state.stores['843D'].availableBp), 800);

  // 4. Downward sheet correction: sheet VL drops from 2 to 1 -> flags an explicit reconciliation issue for Admin review
  const sheetRowsDown = [
    { id: '843D', vl: 1, bts: 0, hsi: 0, acc: 50 }
  ];
  const syncDown = engine.reconcileSheetSnapshot(state, sheetRowsDown, cutoff1107Ms + 3000);
  assert.equal(syncDown.issuesCreated, 1);
  assert.equal(state.reconciliationIssues[0].type, 'DOWNWARD_CORRECTION');

  // 5. Late sale arriving after event closing is quarantined until explicit Admin attribution
  const afterCloseMs = time.easternWallTimeToEpochMs(2026, 10, 19, 21, 0, 0);
  const lateRes = engine.enqueueSalesEntry(state, {
    storeId: '693D',
    category: 'vl',
    qty: 1,
    sourceTimestampMs: afterCloseMs,
    ingestedAtMs: afterCloseMs
  });
  assert.equal(lateRes.status, 'QUARANTINED_LATE_SALE');
  assert.equal(scoring.bpToPoints(state.stores['693D'].availableBp), 0);
});

// ---------------------------------------------------------------------------
// 4. COMBAT: NORMAL ATTACKS, TWO-ATTACK LIMIT, STANDING AT ZERO, REVIVALS (Sections 7, 9, 10)
// ---------------------------------------------------------------------------
test('Sections 7, 9 & 10: Normal attacks (200/400), 2-attack limit per round, standing at zero, and revivals (200 outside / 400 inside / locked in Power Phase)', () => {
  const startMs = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 0, 0);
  let state = engine.createInitialDatabaseState(startMs);

  // Give 843D 1 VL + $50 Acc (300 base + 300 bonus = 600 pts),
  // Give 693D 1 VL + $50 Acc (300 base + 300 bonus = 600 pts),
  // Give 561D 1 HSI (600 base + 600 bonus = 1,200 pts) at 11:00 AM
  engine.enqueueSalesEntry(state, { storeId: '843D', category: 'vl', qty: 1, ingestedAtMs: startMs });
  engine.enqueueSalesEntry(state, { storeId: '843D', category: 'acc', qty: 50, ingestedAtMs: startMs }); // 600 pts
  engine.enqueueSalesEntry(state, { storeId: '693D', category: 'vl', qty: 1, ingestedAtMs: startMs });
  engine.enqueueSalesEntry(state, { storeId: '693D', category: 'acc', qty: 50, ingestedAtMs: startMs }); // 600 pts
  engine.enqueueSalesEntry(state, { storeId: '561D', category: 'hsi', qty: 1, ingestedAtMs: startMs }); // 1200 pts

  // Advance to Round 1 (11:10 AM) — releases the 11:07 AM cutoff sales
  const r1Ms = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 10, 30);
  engine.processScheduledBoundaries(state, r1Ms);

  // Set 843D availableBp to 400 so 2 attacks (200 each) bring 843D to exactly 0 while staying STANDING
  state.stores['843D'].availableBp = scoring.pointsToBp(400);

  // 843D attacks 693D twice in the same round!
  // Attack 1: 843D spends 200 (200 left), 693D takes 400 dmg (200 left, still STANDING)
  const atk1 = engine.executeAttack(state, {
    attackerId: '843D',
    targetId: '693D',
    attackMode: 'NORMAL',
    idempotencyKey: 'atk-1',
    nowMs: r1Ms + 1000
  });
  assert.equal(atk1.logEntry.resultingKnockout, false);
  assert.equal(scoring.bpToPoints(state.stores['843D'].availableBp), 200);
  assert.equal(scoring.bpToPoints(state.stores['693D'].availableBp), 200);

  // Attack 2 (same target allowed): 843D spends 200 (0 left, STILL STANDING!), 693D takes 400 dmg -> clamped to 0, KNOCKED_OUT!
  const atk2 = engine.executeAttack(state, {
    attackerId: '843D',
    targetId: '693D',
    attackMode: 'NORMAL',
    idempotencyKey: 'atk-2',
    nowMs: r1Ms + 2000
  });
  assert.equal(atk2.logEntry.resultingKnockout, true);
  assert.equal(scoring.bpToPoints(state.stores['843D'].availableBp), 0);
  assert.equal(state.stores['843D'].status, 'STANDING'); // Spending own points to 0 does NOT knock out!
  assert.equal(state.stores['693D'].status, 'KNOCKED_OUT');
  assert.equal(scoring.bpToPoints(state.stores['693D'].salesEarnedBp), 600); // Earned points never reduced by damage!

  // 3rd attack in same round is rejected (max 2 accepted attacks per store per round)
  state.stores['843D'].availableBp += scoring.pointsToBp(400);
  assert.throws(() => {
    engine.executeAttack(state, {
      attackerId: '843D',
      targetId: '561D',
      attackMode: 'NORMAL',
      idempotencyKey: 'atk-3',
      nowMs: r1Ms + 3000
    });
  }, /already used the maximum 2 attacks/);

  // Bring 843D back down to 0 available points to test standing-at-zero knockout
  state.stores['843D'].availableBp = 0;
  assert.equal(state.stores['843D'].status, 'STANDING');

  // 561D attacks standing 843D who is at 0 available points -> 843D is knocked out!
  const atkZero = engine.executeAttack(state, {
    attackerId: '561D',
    targetId: '843D',
    attackMode: 'NORMAL',
    idempotencyKey: 'atk-zero',
    nowMs: r1Ms + 3500
  });
  assert.equal(atkZero.logEntry.resultingKnockout, true);
  assert.equal(state.stores['843D'].status, 'KNOCKED_OUT');

  // Give 843D 400 pts so it can revive DURING the battle round (cost: 400 pts)
  state.stores['843D'].availableBp = scoring.pointsToBp(400);
  const revInRound = engine.executeRevival(state, {
    storeId: '843D',
    idempotencyKey: 'rev-in-round',
    nowMs: r1Ms + 3700
  });
  assert.equal(revInRound.logEntry.costPoints, 400);
  assert.equal(state.stores['843D'].status, 'STANDING');
  // Revival does NOT grant a fresh attack allowance in the current round!
  assert.equal(state.currentEvent.roundStates[state.currentEvent.activeRoundId].attacksByStore['843D'], 2);

  // Give 693D 200 pts and revive OUTSIDE the battle round (at 11:16 AM, cost: 200 pts)
  const afterR1Ms = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 16, 0);
  engine.processScheduledBoundaries(state, afterR1Ms);
  state.stores['693D'].availableBp = scoring.pointsToBp(200);
  const revOutRound = engine.executeRevival(state, {
    storeId: '693D',
    idempotencyKey: 'rev-out-round',
    nowMs: afterR1Ms + 1000
  });
  assert.equal(revOutRound.logEntry.costPoints, 200);
  assert.equal(state.stores['693D'].status, 'STANDING');
});

// ---------------------------------------------------------------------------
// 5. DEFLECTION — REGULAR HOURS ONLY (Section 11)
// ---------------------------------------------------------------------------
test('Section 11: Deflection unlock at 120m, 2 survivals in [0, 120m), 1,350-pt round snapshot, Simple (200/100) vs Breaker (400/500), and next-round restoration', () => {
  const startMs = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 0, 0);
  let state = engine.createInitialDatabaseState(startMs);

  // Set starting balances at 11:00 AM: 843D = 2,600 pts, 693D = 2,000 pts, 561D = 2,000 pts
  state.stores['843D'].availableBp = scoring.pointsToBp(2600);
  state.stores['693D'].availableBp = scoring.pointsToBp(2000);
  state.stores['561D'].availableBp = scoring.pointsToBp(2000);

  // Round 1 (11:10 AM, inside first 120 minutes): 693D hits 843D twice; 843D survives both (2600 -> 2200 -> 1800)
  const r1Ms = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 10, 15);
  engine.processScheduledBoundaries(state, r1Ms);

  engine.executeAttack(state, { attackerId: '693D', targetId: '843D', attackMode: 'NORMAL', idempotencyKey: 'd-q1', nowMs: r1Ms + 1000 });
  assert.equal(state.stores['843D'].deflection.survivedAttacksInFirst120, 1);
  assert.equal(state.stores['843D'].deflection.qualifiedForDay, false);

  engine.executeAttack(state, { attackerId: '693D', targetId: '843D', attackMode: 'NORMAL', idempotencyKey: 'd-q2', nowMs: r1Ms + 2000 });
  assert.equal(state.stores['843D'].deflection.survivedAttacksInFirst120, 2);
  assert.equal(state.stores['843D'].deflection.qualifiedForDay, true);

  // At 12:50 PM round (110 minutes after start, BEFORE 120m unlock at 1:00 PM), Deflection is NOT active yet!
  const r1250Ms = time.easternWallTimeToEpochMs(2026, 10, 19, 12, 50, 15);
  engine.processScheduledBoundaries(state, r1250Ms);
  assert.equal(state.stores['843D'].deflection.activeForRoundId, null);

  // At 1:10 PM round (130 minutes after start, >= 120m unlock), 843D has 1,800 pts (>= 1,350) -> Deflection IS active!
  const r1310Ms = time.easternWallTimeToEpochMs(2026, 10, 19, 13, 10, 15);
  engine.processScheduledBoundaries(state, r1310Ms);
  assert.equal(state.stores['843D'].deflection.activeForRoundId, 'rnd_2026-10-19_1310');

  // 693D attacks 843D with Attack 1 (NORMAL/SIMPLE) -> DEFLECTED! 693D pays 200, 843D takes only 100 damage (1800 -> 1700)!
  const defAtk1 = engine.executeAttack(state, {
    attackerId: '693D',
    targetId: '843D',
    attackMode: 'NORMAL',
    idempotencyKey: 'def-atk-1',
    nowMs: r1310Ms + 1000
  });
  assert.equal(defAtk1.logEntry.attackType, 'SIMPLE_DEFLECTED');
  assert.equal(defAtk1.logEntry.costPoints, 200);
  assert.equal(defAtk1.logEntry.damagePoints, 100);
  assert.equal(scoring.bpToPoints(state.stores['843D'].availableBp), 1700);

  // Different attacker (561D) cannot use BREAKER before landing its own deflected hit on 843D in this round
  assert.throws(() => {
    engine.executeAttack(state, {
      attackerId: '561D',
      targetId: '843D',
      attackMode: 'BREAKER',
      idempotencyKey: 'bad-breaker',
      nowMs: r1310Ms + 1500
    });
  }, /Deflection Breaker requires .* to have already landed a deflected hit/);

  // 693D uses Attack 2 as SIMPLE -> costs 200, deals 100 damage (1700 -> 1600), leaves Deflection intact for other attackers!
  const followSimple = engine.executeAttack(state, {
    attackerId: '693D',
    targetId: '843D',
    attackMode: 'SIMPLE',
    idempotencyKey: 'def-simple-2',
    nowMs: r1310Ms + 2000
  });
  assert.equal(followSimple.logEntry.costPoints, 200);
  assert.equal(followSimple.logEntry.damagePoints, 100);
  assert.equal(scoring.bpToPoints(state.stores['843D'].availableBp), 1600);
  assert.equal(state.stores['843D'].deflection.activeForRoundId, 'rnd_2026-10-19_1310');

  // Now 561D attacks 843D with Attack 1 -> SIMPLE_DEFLECTED (100 dmg -> 1500), then uses Attack 2 as BREAKER (400 cost / 500 dmg -> 1000)
  const def561_1 = engine.executeAttack(state, {
    attackerId: '561D',
    targetId: '843D',
    attackMode: 'NORMAL',
    idempotencyKey: 'def-561-1',
    nowMs: r1310Ms + 3000
  });
  assert.equal(def561_1.logEntry.attackType, 'SIMPLE_DEFLECTED');
  assert.equal(scoring.bpToPoints(state.stores['843D'].availableBp), 1500);

  const breaker561_2 = engine.executeAttack(state, {
    attackerId: '561D',
    targetId: '843D',
    attackMode: 'BREAKER',
    idempotencyKey: 'def-561-2',
    nowMs: r1310Ms + 4000
  });
  assert.equal(breaker561_2.logEntry.attackType, 'DEFLECTION_BREAKER');
  assert.equal(breaker561_2.logEntry.costPoints, 400);
  assert.equal(breaker561_2.logEntry.damagePoints, 500);
  assert.equal(scoring.bpToPoints(state.stores['843D'].availableBp), 1000); // 1500 - 500 = 1000
  assert.equal(state.stores['843D'].deflection.activeForRoundId, null);
  assert.equal(state.stores['843D'].deflection.brokenInRoundId, 'rnd_2026-10-19_1310');

  // Next round (1:30 PM): 843D now has 1,000 pts (< 1,350 threshold), so Deflection does NOT activate at round start
  const r1330Ms = time.easternWallTimeToEpochMs(2026, 10, 19, 13, 30, 15);
  engine.processScheduledBoundaries(state, r1330Ms);
  assert.equal(state.stores['843D'].deflection.activeForRoundId, null);

  // Give 843D +400 pts before 1:50 PM round so it has 1,400 pts (>= 1,350) -> Deflection restores for 1:50 PM round!
  state.stores['843D'].availableBp += scoring.pointsToBp(400);
  const r1350Ms = time.easternWallTimeToEpochMs(2026, 10, 19, 13, 50, 15);
  engine.processScheduledBoundaries(state, r1350Ms);
  assert.equal(state.stores['843D'].deflection.activeForRoundId, 'rnd_2026-10-19_1350');
});

// ---------------------------------------------------------------------------
// 6. POWER PHASE ENTRY (350 PTS / DRAW), SHIELDS & AUTOMATIC ELIMINATIONS (Sections 12, 13, 14)
// ---------------------------------------------------------------------------
test('Section 12: Power Phase 350-point entry check and all-below-350 DRAW behavior', () => {
  const startMs = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 0, 0);
  let state = engine.createInitialDatabaseState(startMs);

  // Give 843D 200 pts and 693D 200 pts (all stores < 350 available points at 5:45 PM Power Phase entry)
  engine.enqueueSalesEntry(state, { storeId: '843D', category: 'vl', qty: 1, ingestedAtMs: startMs });
  engine.enqueueSalesEntry(state, { storeId: '693D', category: 'vl', qty: 1, ingestedAtMs: startMs });

  const powerStartMs = time.easternWallTimeToEpochMs(2026, 10, 19, 17, 45, 0);
  engine.processScheduledBoundaries(state, powerStartMs);

  // Must end immediately in a daily DRAW with 0 daily qualifiers, while preserving earned points!
  assert.equal(state.currentEvent.status, 'ENDED_DRAW');
  assert.equal(state.currentEvent.dailyQualifiers.length, 0);
  assert.equal(scoring.bpToPoints(state.stores['843D'].salesEarnedBp), 200);
  assert.equal(scoring.bpToPoints(state.currentWeek.weeklyStoreLedger['843D'].cumulativeEarnedBp), 200);
});

test('Section 12, 13 & 14: Power Phase Shields (600 pts, 3-min block, 2-min vulnerable) and Automatic Eliminations + Tie Pause', () => {
  const startMs = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 0, 0);
  let state = engine.createInitialDatabaseState(startMs);

  // Setup standing stores before Power Phase (5:45 PM):
  // 843D: $550 Acc (1,100 base + 900 bonus = 2,000 salesEarned & 2,000 avail)
  // 693D: 1 HSI (600 base + 600 bonus = 1,200 salesEarned & 1,200 avail)
  // 561D: $200 Acc (400 base + 300 bonus = 700 salesEarned & 700 avail — tied lowest with 5383!)
  // 5383: $200 Acc (400 base + 300 bonus = 700 salesEarned & 700 avail — tied lowest with 561D!)
  // 769D: 1 VL (200 pts < 350 pts -> eliminated at 5:45 PM Power Phase entry!)
  // Others: 0 pts (< 350 pts -> eliminated at 5:45 PM Power Phase entry!)
  engine.enqueueSalesEntry(state, { storeId: '843D', category: 'acc', qty: 550, ingestedAtMs: startMs });
  engine.enqueueSalesEntry(state, { storeId: '693D', category: 'hsi', qty: 1, ingestedAtMs: startMs });
  engine.enqueueSalesEntry(state, { storeId: '561D', category: 'acc', qty: 200, ingestedAtMs: startMs });
  engine.enqueueSalesEntry(state, { storeId: '5383', category: 'acc', qty: 200, ingestedAtMs: startMs });
  engine.enqueueSalesEntry(state, { storeId: '769D', category: 'vl', qty: 1, ingestedAtMs: startMs });

  // Advance to 5:45 PM Power Phase start
  const powerStartMs = time.easternWallTimeToEpochMs(2026, 10, 19, 17, 45, 0);
  engine.processScheduledBoundaries(state, powerStartMs);
  assert.equal(state.currentEvent.phase, 'POWER_PHASE');
  assert.equal(state.stores['769D'].status, 'KNOCKED_OUT');
  assert.equal(state.stores['843D'].status, 'STANDING');

  // Revivals are disabled in Power Phase
  assert.throws(() => {
    engine.executeRevival(state, { storeId: '769D', idempotencyKey: 'no-power-revive', nowMs: powerStartMs + 1000 });
  }, /Revivals are permanently disabled during the Power Phase/);

  // Between rounds in Power Phase (5:46 PM, before 5:50 PM round): 843D purchases a Power Phase Shield for 600 pts
  const buyShieldMs = time.easternWallTimeToEpochMs(2026, 10, 19, 17, 46, 0);
  const shieldRes = engine.purchaseShield(state, {
    storeId: '843D',
    idempotencyKey: 'shield-1',
    nowMs: buyShieldMs
  });
  assert.equal(shieldRes.logEntry.costPoints, 600);
  assert.equal(scoring.bpToPoints(state.stores['843D'].availableBp), 1400);
  assert.equal(state.stores['843D'].shield.queuedForRoundId, 'rnd_2026-10-19_1750');

  // Cannot buy a second shield for the same upcoming round
  assert.throws(() => {
    engine.purchaseShield(state, { storeId: '843D', idempotencyKey: 'shield-dup', nowMs: buyShieldMs + 1000 });
  }, /already has a Shield queued/);

  // Advance to 5:50 PM round:
  // First 3 minutes [5:50:00, 5:53:00): 843D is shielded!
  const r1750Min1Ms = time.easternWallTimeToEpochMs(2026, 10, 19, 17, 51, 0);
  engine.processScheduledBoundaries(state, r1750Min1Ms);

  // 693D tries to attack shielded 843D at 5:51 PM -> rejected, consumes NO points and NO attack allowance!
  assert.throws(() => {
    engine.executeAttack(state, {
      attackerId: '693D',
      targetId: '843D',
      attackMode: 'NORMAL',
      idempotencyKey: 'atk-shielded',
      nowMs: r1750Min1Ms
    });
  }, /protected by an active Power Phase Shield/);
  assert.equal(scoring.bpToPoints(state.stores['693D'].availableBp), 1200);
  assert.equal(state.currentEvent.roundStates['rnd_2026-10-19_1750'].attacksByStore['693D'] || 0, 0);

  // Final 2 minutes [5:53:00, 5:55:00): 843D is vulnerable!
  const r1750Min4Ms = time.easternWallTimeToEpochMs(2026, 10, 19, 17, 53, 30);
  const hitAfterShield = engine.executeAttack(state, {
    attackerId: '693D',
    targetId: '843D',
    attackMode: 'NORMAL',
    idempotencyKey: 'atk-unshielded',
    nowMs: r1750Min4Ms
  });
  assert.equal(hitAfterShield.logEntry.resultingKnockout, false);
  assert.equal(scoring.bpToPoints(state.stores['843D'].availableBp), 1000); // 1400 - 400 = 1000
  assert.equal(scoring.bpToPoints(state.stores['693D'].availableBp), 1000); // 1200 - 200 = 1000

  // Advance to 6:15 PM First Automatic Elimination Checkpoint!
  // 561D and 5383 are tied at 700 availableBp AND 700 salesEarnedBp -> Checkpoint pauses for Admin tie resolution!
  const cp615Ms = time.easternWallTimeToEpochMs(2026, 10, 19, 18, 15, 0);
  engine.processScheduledBoundaries(state, cp615Ms);
  assert.ok(state.currentEvent.pendingEliminationTie);
  assert.deepEqual(state.currentEvent.pendingEliminationTie.candidateStoreIds.sort(), ['5383', '561D']);

  // Admin resolves tie by eliminating 5383 -> Event continues without shifting scheduled checkpoints or closing!
  engine.resolveEliminationTie(state, {
    eliminatedStoreId: '5383',
    adminNote: 'Lower accessory attach rate',
    nowMs: cp615Ms + 5000
  });
  assert.equal(state.currentEvent.pendingEliminationTie, null);
  assert.equal(state.stores['5383'].status, 'KNOCKED_OUT');
  assert.equal(state.stores['561D'].status, 'STANDING');

  // Advance to 6:45 PM checkpoint -> 561D (700 pts) is now sole lowest standing store -> automatically eliminated!
  const cp645Ms = time.easternWallTimeToEpochMs(2026, 10, 19, 18, 45, 0);
  engine.processScheduledBoundaries(state, cp645Ms);
  assert.equal(state.stores['561D'].status, 'KNOCKED_OUT');

  // Advance to 7:15 PM checkpoint -> Between 843D (1,000 avail) and 693D (1,000 avail):
  // Both 843D and 693D have 1,000 availableBp, EXCEPT 843D has 1,900 salesEarnedBp and 693D has 1,200 salesEarnedBp!
  // Secondary tiebreaker (lower salesEarnedBp) automatically eliminates 693D without needing Admin tie pause!
  const cp715Ms = time.easternWallTimeToEpochMs(2026, 10, 19, 19, 15, 0);
  engine.processScheduledBoundaries(state, cp715Ms);
  assert.equal(state.stores['693D'].status, 'KNOCKED_OUT');
  assert.equal(state.stores['843D'].status, 'STANDING');

  // Advance to 7:45 PM, 8:15 PM, and 8:45 PM closing -> 843D is the last standing store, so it is NEVER eliminated by checkpoints!
  const closeMs = time.easternWallTimeToEpochMs(2026, 10, 19, 20, 45, 0);
  engine.processScheduledBoundaries(state, closeMs);
  assert.equal(state.currentEvent.status, 'ENDED_NORMAL');
  assert.deepEqual(state.currentEvent.dailyQualifiers, ['843D']);
});

// ---------------------------------------------------------------------------
// 7. DAILY CARRYOVER, AVERAGES & SUNDAY 7:00 PM WEEKLY ROLLOVER (Sections 2, 5, 6)
// ---------------------------------------------------------------------------
test('Sections 2, 5 & 6: Daily carryover (spending/damage do not reduce next day opening balance), universal participation, weekly averages, and idempotent Sunday 7 PM rollover', () => {
  // Day 1: Monday 2026-10-19
  const monStartMs = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 0, 0);
  let state = engine.createInitialDatabaseState(monStartMs);

  // 843D earns 3 VLs (600 base + 600 milestone bonus = 1,200 pts)
  // 693D earns 2 VLs (400 base + 300 milestone bonus = 700 pts) on Monday
  engine.enqueueSalesEntry(state, { storeId: '843D', category: 'vl', qty: 3, ingestedAtMs: monStartMs }); // 1,200
  engine.enqueueSalesEntry(state, { storeId: '693D', category: 'vl', qty: 2, ingestedAtMs: monStartMs }); // 700

  // In Round 1 on Monday, 843D attacks 693D twice (843D spends 400 -> 800 avail; 693D takes 800 dmg -> 0 avail, KNOCKED_OUT)
  const monR1Ms = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 10, 15);
  engine.processScheduledBoundaries(state, monR1Ms);
  engine.executeAttack(state, { attackerId: '843D', targetId: '693D', attackMode: 'NORMAL', idempotencyKey: 'm-1', nowMs: monR1Ms + 1000 });
  engine.executeAttack(state, { attackerId: '843D', targetId: '693D', attackMode: 'NORMAL', idempotencyKey: 'm-2', nowMs: monR1Ms + 2000 });
  assert.equal(state.stores['693D'].status, 'KNOCKED_OUT');

  // Close Monday at 8:45 PM
  const monCloseMs = time.easternWallTimeToEpochMs(2026, 10, 19, 20, 45, 0);
  engine.processScheduledBoundaries(state, monCloseMs);
  assert.equal(state.currentEvent.status, 'ENDED_NORMAL');
  assert.deepEqual(state.currentEvent.dailyQualifiers, ['843D']);

  // Day 2: Tuesday 2026-10-20 at 11:00 AM
  const tueStartMs = time.easternWallTimeToEpochMs(2026, 10, 20, 11, 0, 0);
  engine.processScheduledBoundaries(state, tueStartMs);

  // Verify Tuesday rollover rules:
  // 1. Every store is restored to STANDING (including 693D who was knocked out Monday).
  // 2. 843D starts Tuesday with 1,200 carried opening balance (Monday's 400 attack spending did NOT reduce it!).
  // 3. 693D starts Tuesday with 700 carried opening balance (Monday's 800 incoming damage did NOT reduce it!).
  assert.equal(state.currentEvent.dateKey, '2026-10-20');
  assert.equal(state.stores['843D'].status, 'STANDING');
  assert.equal(state.stores['693D'].status, 'STANDING');
  assert.equal(scoring.bpToPoints(state.stores['843D'].carriedOpeningBalanceBp), 1200);
  assert.equal(scoring.bpToPoints(state.stores['843D'].availableBp), 1200);
  assert.equal(scoring.bpToPoints(state.stores['693D'].carriedOpeningBalanceBp), 700);
  assert.equal(scoring.bpToPoints(state.stores['693D'].availableBp), 700);

  // On Tuesday, 843D earns 200 new points (1 VL), 693D earns 0 new points. Close Tuesday at 8:45 PM.
  engine.enqueueSalesEntry(state, { storeId: '843D', category: 'vl', qty: 1, ingestedAtMs: tueStartMs });
  const tueCloseMs = time.easternWallTimeToEpochMs(2026, 10, 20, 20, 45, 0);
  engine.processScheduledBoundaries(state, tueCloseMs);

  // Check weekly standings & average daily earned points across 2 counted event days:
  // 843D: 1,200 (Mon) + 200 (Tue) = 1,400 total earned, average = 700 pts/day (carried balance NOT double-counted!)
  // 693D: 700 (Mon) + 0 (Tue) = 700 total earned, average = 350 pts/day
  const weekly = engine.getWeeklyStandings(state);
  assert.equal(weekly.countedDaysCount, 2);
  const rank1 = weekly.standings.find((r) => r.storeId === '843D');
  const rank2 = weekly.standings.find((r) => r.storeId === '693D');
  assert.equal(rank1.cumulativeEarnedPoints, 1400);
  assert.equal(rank1.averageDailyEarnedPoints, 700);
  assert.equal(rank2.cumulativeEarnedPoints, 700);
  assert.equal(rank2.averageDailyEarnedPoints, 350);

  // Sunday 7:00 PM ET Weekly Rollover:
  const nextSunRolloverMs = time.easternWallTimeToEpochMs(2026, 10, 25, 19, 0, 0);
  engine.processScheduledBoundaries(state, nextSunRolloverMs);
  assert.equal(state.currentWeek.weekId, 'week_2026-10-25_to_2026-11-01');
  assert.equal(state.weeklyArchives.length, 1);
  assert.equal(state.weeklyArchives[0].weekId, 'week_2026-10-18_to_2026-10-25');
  assert.equal(scoring.bpToPoints(state.currentWeek.weeklyStoreLedger['843D'].cumulativeEarnedBp), 0);

  // Repeating rollover at the same timestamp is idempotent
  engine.processScheduledBoundaries(state, nextSunRolloverMs);
  assert.equal(state.weeklyArchives.length, 1);
});

// ---------------------------------------------------------------------------
// 8. MIGRATION (Section 19) & AUTH / CONCURRENCY / PERSISTENCE (Sections 17, 18)
// ---------------------------------------------------------------------------
test('Section 19: v1 -> v2 schema migration preserves backup and recalculates 769D sales quantities with HINT=600 and +300 milestone bonus', () => {
  const v1Raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state-db.json'), 'utf8'));
  const migrated = migration.migrateV1ToV2(v1Raw, time.easternWallTimeToEpochMs(2026, 10, 18, 15, 0, 0));

  assert.equal(migrated.schemaVersion, 2);
  assert.ok(migrated.migrationMeta.legacyBackup);
  assert.equal(migrated.migrationMeta.legacyBackup.version, 15);

  // In state-db.json, 769D has beyondVl: 3 (folded into 3 standard VLs = 600 base pts) and hsi: 1 (1 * 600 = 600 base pts)
  // -> 1,200 base sales pts + 4 milestones (1,200 bonus pts) = 2,400 total points!
  const store769 = migrated.stores['769D'];
  assert.equal(scoring.bpToPoints(store769.baseSalesEarnedBp), 1200);
  assert.equal(scoring.bpToPoints(store769.salesMilestoneBonusBp), 1200);
  assert.equal(scoring.bpToPoints(store769.salesEarnedBp), 2400);
  assert.equal(scoring.bpToPoints(store769.availableBp), 2400);
});

test('Sections 17 & 18: Server-side Admin PIN 2626, no store login required for store actions, idempotency keys, and concurrent serialized transactions', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
  const testDbFile = path.join(tmpDir, 'state-db.json');
  const testBackupFile = path.join(tmpDir, 'state-db.v1-backup.json');
  process.env.KO_DB_FILE = testDbFile;
  process.env.KO_BACKUP_FILE = testBackupFile;
  delete process.env.ADMIN_PIN; // Verify default PIN 2626 works out of the box
  delete process.env.STORE_ACCESS_CODES; // Verify no store login required

  try {
    const eventStartMs = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 0, 0);
    const round1Ms = time.easternWallTimeToEpochMs(2026, 10, 19, 11, 10, 30);

    await storage.transactState((state) => {
      const fresh = engine.createInitialDatabaseState(eventStartMs);
      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, fresh);
      engine.enqueueSalesEntry(state, { storeId: '843D', category: 'hsi', qty: 1, ingestedAtMs: eventStartMs }); // 600 base + 600 bonus = 1200 pts
      engine.enqueueSalesEntry(state, { storeId: '693D', category: 'hsi', qty: 1, ingestedAtMs: eventStartMs }); // 600 base + 600 bonus = 1200 pts
      engine.processScheduledBoundaries(state, round1Ms);
      return { ok: true };
    }, { nowMs: round1Ms });

    // 1. Unauthorized Admin request (missing or wrong PIN) is rejected with 401
    const unauthAdmin = await handleApiRequest({
      method: 'POST',
      headers: {},
      body: { action: 'admin_adjust_bonus', storeId: '843D', points: 200, reason: 'Hack' },
      options: { nowMs: round1Ms }
    });
    assert.equal(unauthAdmin.statusCode, 401);

    // 2. Admin PIN 2626 succeeds
    const adminLoginRes = await handleApiRequest({
      method: 'POST',
      headers: {},
      body: { action: 'verify_admin', pin: '2626' },
      options: { nowMs: round1Ms }
    });
    assert.equal(adminLoginRes.statusCode, 200);
    assert.equal(adminLoginRes.bodyObj.ok, true);

    // 3. No store login required: Store 843D can submit combat actions directly by selecting storeId
    // Concurrent / duplicate attack submissions with the same idempotencyKey only execute once!
    const reqPayload = {
      method: 'POST',
      headers: {},
      body: {
        action: 'store_attack',
        storeId: '843D',
        targetId: '693D',
        attackMode: 'NORMAL',
        idempotencyKey: 'concurrent-idem-key-1'
      },
      options: { nowMs: round1Ms + 2000 }
    };

    const [resA, resB] = await Promise.all([
      handleApiRequest(reqPayload),
      handleApiRequest(reqPayload)
    ]);
    assert.equal(resA.statusCode, 200);
    assert.equal(resB.statusCode, 200);

    const { state: afterState } = await storage.readRawStateFromStorage({ dbFilePath: testDbFile });
    assert.equal(scoring.bpToPoints(afterState.stores['843D'].availableBp), 1000); // 1200 - 200 = 1000 (deducted only once)
    assert.equal(scoring.bpToPoints(afterState.stores['693D'].availableBp), 800);  // 1200 - 400 = 800 (damaged only once)
    assert.equal(afterState.currentEvent.roundStates['rnd_2026-10-19_1110'].attacksByStore['843D'], 1);
  } finally {
    delete process.env.KO_DB_FILE;
    delete process.env.KO_BACKUP_FILE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Sections 3, 14 & 15: Sunday exception timeline (1:00 PM start, 3:45 PM final stretch, 4:15 PM checkpoint before 4:45 PM Power Phase entry, 5:45 PM close) and deterministic boundary ordering', () => {
  // Sunday 2026-10-18
  const sunStartMs = time.easternWallTimeToEpochMs(2026, 10, 18, 13, 0, 0);
  let state = engine.createInitialDatabaseState(sunStartMs);

  // Set store balances at 1:00 PM:
  // 843D: 1200, 693D: 1000, 561D: 800, 5383: 600, 582D/892E/697D: 400 (tied), 769D: 300 (<350), 5733: 200 (lowest at 4:15 PM)
  const initialBalances = {
    '843D': 1200,
    '693D': 1000,
    '561D': 800,
    '5383': 600,
    '582D': 400,
    '892E': 400,
    '697D': 400,
    '769D': 300,
    '5733': 200
  };
  for (const [id, pts] of Object.entries(initialBalances)) {
    state.stores[id].availableBp = scoring.pointsToBp(pts);
    state.stores[id].salesEarnedBp = scoring.pointsToBp(pts);
  }

  // 1. At 3:45 PM ET: Sunday Final Stretch begins (Power Phase has NOT started yet!)
  const sun345Ms = time.easternWallTimeToEpochMs(2026, 10, 18, 15, 45, 0);
  engine.processScheduledBoundaries(state, sun345Ms);
  assert.equal(state.currentEvent.phase, 'FINAL_STRETCH');

  // 2. At 4:15 PM ET: First Sunday automatic elimination checkpoint occurs BEFORE Power Phase!
  // Lowest standing store is 5733 (200 pts) -> eliminated at 4:15 PM!
  const sun415Ms = time.easternWallTimeToEpochMs(2026, 10, 18, 16, 15, 0);
  engine.processScheduledBoundaries(state, sun415Ms);
  assert.equal(state.stores['5733'].status, 'KNOCKED_OUT');
  assert.equal(state.stores['769D'].status, 'STANDING'); // Still standing until 4:45 PM!

  // 3. At 4:45 PM ET: Coinciding boundary!
  // Step 4 (Power Phase 350-pt entry check) runs BEFORE Step 5 (4:45 PM elimination checkpoint):
  // - Step 4 eliminates 769D (300 pts < 350 pts).
  // - Step 5 then evaluates remaining standing stores (lowest are 582D, 892E, 697D tied at 400 pts -> pauses for tie!).
  const sun445Ms = time.easternWallTimeToEpochMs(2026, 10, 18, 16, 45, 0);
  engine.processScheduledBoundaries(state, sun445Ms);
  assert.equal(state.currentEvent.phase, 'POWER_PHASE');
  assert.equal(state.stores['769D'].status, 'KNOCKED_OUT');
  assert.equal(state.stores['769D'].eliminatedReason, 'POWER_PHASE_BELOW_350');
  assert.ok(state.currentEvent.pendingEliminationTie);
  assert.deepEqual(state.currentEvent.pendingEliminationTie.candidateStoreIds.sort(), ['582D', '697D', '892E']);
});

