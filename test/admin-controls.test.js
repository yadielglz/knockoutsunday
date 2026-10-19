'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handleApiRequest } = require('../lib/api-handler');
const { transactState, readRawStateFromStorage } = require('../lib/storage');
const { reconcileSheetSnapshot } = require('../lib/engine');
const { getConfiguredAdminPin } = require('../lib/auth');
const nowMs = Date.parse('2026-10-19T15:10:00Z');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-admin-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const options = { dbFilePath:path.join(dir,'state.json'), nowMs };
  const call = (action, body = {}, sandbox = false) => handleApiRequest({ method:'POST', headers:{ 'x-admin-pin':getConfiguredAdminPin(), ...(sandbox ? {'x-game-zone':'sandbox'} : {}) }, body:{action,...body}, options });
  return { dir, options, call };
}
test('Test Zone requires admin credentials and cannot be invoked in live mode', async t => {
  const { options, call } = fixture(t);
  const denied = await handleApiRequest({method:'GET', headers:{'x-game-zone':'sandbox'}, options});
  assert.equal(denied.statusCode,401);
  assert.equal((await call('admin_test_seed',{scenario:'battle'})).statusCode,400);
  assert.equal(fs.existsSync(options.dbFilePath),false);
});
test('test rounds and clock are isolated; simulation enforces real attack limits', async t => {
  const { options, call } = fixture(t);
  await transactState(state => { state.announcement = {text:'LIVE ONLY'}; }, options);
  const liveBefore = fs.readFileSync(options.dbFilePath,'utf8');
  let res = await call('admin_test_seed',{scenario:'battle'},true);
  assert.equal(res.statusCode,200);
  const clock = res.bodyObj.sandboxClockMs;
  assert.ok(res.bodyObj.currentEvent.activeRoundId);
  const initialBalance = res.bodyObj.stores['843D'].availableBp;
  for (let i=0;i<2;i++) {
    res = await call('admin_test_combat',{kind:'attack',actorId:'843D',targetId:'693D',idempotencyKey:`attack${i}`},true);
    assert.equal(res.statusCode,200,JSON.stringify(res.bodyObj));
  }
  assert.ok(res.bodyObj.stores['843D'].availableBp < initialBalance);
  assert.equal((await call('admin_test_combat',{kind:'attack',actorId:'843D',targetId:'693D'},true)).statusCode,400);
  const read = await handleApiRequest({ method:'GET', headers:{'x-admin-pin':getConfiguredAdminPin(),'x-game-zone':'sandbox'}, options:{...options,nowMs:nowMs+86400000} });
  assert.equal(read.bodyObj.serverNowMs,clock);
  res = await call('admin_test_advance',{minutes:5},true);
  assert.equal(res.bodyObj.serverNowMs,clock+300000);
  assert.equal(fs.readFileSync(options.dbFilePath,'utf8'),liveBefore);
});
test('admin cannot join a store or perform a store action', async t => {
  const { call } = fixture(t);
  for (const action of ['authenticate_store','store_attack','store_revive','store_purchase_shield']) {
    assert.equal((await call(action,{storeId:'843D',targetId:'693D'})).statusCode,403);
  }
});
test('reset combat keeps earnings and quantities, restores stores, and saves the old database', async t => {
  const { options, call } = fixture(t);
  await transactState(state => {
    const s = state.stores['843D'];
    Object.assign(s,{totalEarnedBp:200000,availableBp:1000,adminBonusBp:200000,incomingDamageBp:199000,status:'KNOCKED_OUT'});
    s.quantities.accCents = 12345;
  }, options);
  assert.equal((await call('admin_reset_combat')).statusCode,400);
  const reset = await call('admin_reset_combat',{confirmation:'RESET COMBAT'});
  assert.equal(reset.statusCode,200);
  const s = reset.bodyObj.stores['843D'];
  assert.equal(s.status,'STANDING');
  assert.equal(s.availableBp,200000);
  assert.equal(s.quantities.accCents,12345);
  const backups = fs.readdirSync(`${options.dbFilePath}.backups`);
  assert.equal(backups.length,1);
  const backup = JSON.parse(fs.readFileSync(path.join(`${options.dbFilePath}.backups`,backups[0])));
  assert.equal(backup.stores['843D'].status,'KNOCKED_OUT');
});
test('new tournament archives its previous week; clear removes history and pauses imports', async t => {
  const { options, call } = fixture(t);
  await transactState(state => { state.stores['843D'].adminBonusBp = 123000; state.stores['843D'].availableBp = 123000; }, options);
  const next = await call('admin_new_tournament',{confirmation:'NEW TOURNAMENT'});
  assert.equal(next.statusCode,200);
  assert.equal(next.bodyObj.weeklyArchives.length,1);
  assert.equal(next.bodyObj.stores['843D'].availableBp,0);
  assert.equal(next.bodyObj.sheetImportsPaused,true);
  await transactState(state => {
    const result = reconcileSheetSnapshot(state,[{id:'843D',vl:100,bts:0,hsi:0,accCents:100000}],nowMs);
    assert.equal(result.paused,true);
    assert.equal(state.stores['843D'].availableBp,0);
  }, options);
  const clear = await call('admin_clear_database',{confirmation:'CLEAR DATABASE'});
  assert.equal(clear.bodyObj.weeklyArchives.length,0);
  assert.equal(Object.keys(clear.bodyObj.stores).length,9);
  assert.equal(clear.bodyObj.sheetImportsPaused,true);
  const resumed = await call('admin_resume_imports');
  assert.equal(resumed.bodyObj.sheetImportsPaused,false);
  const exported = await call('admin_export_backup');
  assert.ok(exported.bodyObj.backupId);
  assert.ok(exported.bodyObj.snapshot.stores);
});
test('Power Hour and deflection test scenarios are reproducible outside live hours', async t => {
  const { call } = fixture(t);
  const deflection = await call('admin_test_seed',{scenario:'deflection'},true);
  assert.equal(deflection.statusCode,200);
  assert.equal(deflection.bodyObj.stores['843D'].deflection.qualifiedForDay,true);
  assert.ok(deflection.bodyObj.currentEvent.activeRoundId);
  const power = await call('admin_test_seed',{scenario:'power'},true);
  assert.equal(power.statusCode,200);
  assert.equal(power.bodyObj.currentEvent.phase,'POWER_PHASE');
  assert.equal((await call('admin_test_combat',{kind:'shield',actorId:'843D'},true)).statusCode,200);
});
test('a backup failure leaves active game data unchanged', async t => {
  const { options, call } = fixture(t);
  await transactState(state => { state.announcement = { text:'keep me' }; }, options);
  const before = fs.readFileSync(options.dbFilePath,'utf8');
  fs.writeFileSync(`${options.dbFilePath}.backups`,'blocks backup directory');
  const res = await call('admin_clear_database',{confirmation:'CLEAR DATABASE'});
  assert.equal(res.statusCode,400);
  assert.equal(fs.readFileSync(options.dbFilePath,'utf8'),before);
});
