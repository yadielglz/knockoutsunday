'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const engine=require('../lib/engine');
const time=require('../lib/time');
const scoring=require('../lib/scoring');
const {parseGoogleSheetCSV}=require('../lib/storage');
const at=(day,h,m=0)=>time.easternWallTimeToEpochMs(2026,10,day,h,m);
const rows=(vl=2)=>engine.OFFICIAL_ROSTER.map(s=>({id:s.id,vl,bts:1,hsi:0,acc:25}));

test('after-close Sunday sheet is credited automatically to the week that ended, not the new week',()=>{
 const state=engine.createInitialDatabaseState(at(18,21));
 const oldStatus=state.currentEvent.status;
 engine.reconcileSheetSnapshot(state,rows(),at(18,21));
 const old=state.weeklyArchives.find(w=>w.weekId==='week_2026-10-11_to_2026-10-18');
 assert.ok(old);
 assert.equal(old.weeklyStoreLedger['843D'].cumulativeEarnedBp,scoring.calculateSalesPointsBp({totalVl:2,bts:1,accCents:2500}).totalSalesBp);
 assert.equal(state.currentWeek.weeklyStoreLedger['843D'].cumulativeEarnedBp,0);
 assert.equal(state.latestSheetReport.dateKey,'2026-10-18');
 assert.equal(state.currentEvent.status,oldStatus,'import must not replay or end combat');
 const auditCount=state.auditLog.length;
 engine.reconcileSheetSnapshot(state,rows(),at(18,22));
 assert.equal(old.weeklyStoreLedger['843D'].dailyBreakdown['2026-10-18'].salesEarnedBp,old.weeklyStoreLedger['843D'].cumulativeEarnedBp);
 assert.equal(state.auditLog.length,auditCount);
 assert.equal(engine.getWeeklyStandings(state).standings[0].cumulativeEarnedBp,0);
});

test('legacy held sheet imports are recovered once with status and spending preserved',()=>{
 const state=engine.createInitialDatabaseState(at(18,14));
 state.currentWeek=engine.createInitialDatabaseState(at(18,21)).currentWeek;
 state.currentEvent.weekId=state.currentWeek.weekId; // Legacy deployment linked Sunday to the new week.
 state.currentEvent.status='ENDED_DRAW';state.currentEvent.dailyQualifiers=[];
 const store=state.stores['843D'];store.status='KNOCKED_OUT';store.attackSpentBp=20000;store.availableBp=0;
 store.sheetBaseline={initialized:true,vl:2,bts:1,hsi:0,accCents:2500};
 state.reconciliationIssues.push({issueId:'held',type:'LATE_CROSS_BOUNDARY_SALE',source:'SHEET',ingestedAtMs:at(18,19,21),resolved:false});
 engine.reconcileSheetSnapshot(state,rows(),at(18,21,45));
 assert.equal(state.reconciliationIssues[0].resolved,true);
 assert.equal(store.status,'KNOCKED_OUT');assert.equal(store.attackSpentBp,20000);
 assert.ok(store.salesEarnedBp>0);assert.equal(store.pendingBp,0);
 assert.deepEqual(state.currentEvent.dailyQualifiers,[]);
 assert.equal(state.currentEvent.status,'ENDED_DRAW');
 const before=store.salesEarnedBp;engine.reconcileSheetSnapshot(state,rows(),at(18,22));assert.equal(store.salesEarnedBp,before);
});

test('active-day imports preserve cutoff pending behavior and then settle at close',()=>{
 const state=engine.createInitialDatabaseState(at(19,10,50));
 engine.startDailyEvent(state,at(19,11));
 engine.reconcileSheetSnapshot(state,rows(),at(19,11,5));
 assert.equal(state.stores['843D'].salesEarnedBp,0);assert.ok(state.stores['843D'].pendingBp>0);
 engine.processScheduledBoundaries(state,at(19,11,7));assert.ok(state.stores['843D'].salesEarnedBp>0);
 engine.reconcileSheetSnapshot(state,rows(3),at(19,21));
 assert.equal(state.sheetReports['2026-10-19'].status,'RECORDED_IN_EVENT_WEEK');
 assert.equal(state.stores['843D'].quantities.totalVl,3);
 assert.equal(state.currentWeek.weeklyStoreLedger['843D'].dailyBreakdown['2026-10-19'].salesEarnedBp,state.stores['843D'].salesEarnedBp);
});

test('unchanged undated source stays on Sunday overnight; a reset starts Monday data',()=>{
 const state=engine.createInitialDatabaseState(at(18,21));
 engine.reconcileSheetSnapshot(state,rows(),at(18,21));
 engine.processScheduledBoundaries(state,at(19,10));
 engine.reconcileSheetSnapshot(state,rows(),at(19,10));
 assert.equal(state.latestSheetReport.dateKey,'2026-10-18');
 assert.equal(state.stores['843D'].pendingBp,0);
 const reset=rows(0).map(r=>({...r,bts:0,acc:0}));
 engine.reconcileSheetSnapshot(state,reset,at(19,10,30));
 assert.equal(state.latestSheetReport.dateKey,'2026-10-19');
 engine.reconcileSheetSnapshot(state,rows(1),at(19,11,5));
 engine.processScheduledBoundaries(state,at(19,11,7));
 assert.equal(state.stores['843D'].quantities.totalVl,1);
});

test('explicit sheet report date wins over import day and future dates are rejected',()=>{
 const state=engine.createInitialDatabaseState(at(19,10));
 const csv='Report Date,2026-10-18\n,843D - El Cartel,,,0,0,,0,$25,,0,0,,2,1,0,0,0';
 const parsed=parseGoogleSheetCSV(csv);assert.equal(parsed.reportDateKey,'2026-10-18');
 engine.reconcileSheetSnapshot(state,parsed,at(19,10));
 assert.equal(state.latestSheetReport.attribution,'EXPLICIT_SHEET_DATE');
 assert.equal(state.latestSheetReport.dateKey,'2026-10-18');
 assert.throws(()=>engine.reconcileSheetSnapshot(state,rows(),at(19,10),'2026-10-20'),/future/);
});

test('closed imports match manual entries and preserve corrections without double counting',()=>{
 const state=engine.createInitialDatabaseState(at(19,10));engine.startDailyEvent(state,at(19,11));
 engine.enqueueSalesEntry(state,{storeId:'843D',category:'vl',qty:1,source:'MANUAL',ingestedAtMs:at(19,11)});
 engine.processScheduledBoundaries(state,at(19,11,7));
 state.stores['843D'].adminBonusBp=-10000;
 engine.reconcileSheetSnapshot(state,rows(1),at(19,21));
 assert.equal(state.stores['843D'].quantities.totalVl,1);
 assert.equal(state.stores['843D'].adminBonusBp,-10000);
 assert.equal(state.unreconciledManualEntries[0].reconciled,true);
});
