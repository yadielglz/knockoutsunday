'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Use the real Lambda context adapter with a fake durable store; no production data touched.
const sdkPath = require.resolve('@netlify/blobs');
const sdk = require(sdkPath);
const objects = new Map();
let sequence = 0;
let failReads = false;
let conflictOnce = false;
let reads = 0;
let writes = [];

require.cache[sdkPath].exports = {
  ...sdk,
  getStore({ name }) {
    assert.ok(process.env.NETLIFY_BLOBS_CONTEXT || globalThis.netlifyBlobsContext, 'Lambda context must be attached before accessing storage');
    return {
      async getWithMetadata(key) {
        reads++;
        if (failReads) throw new Error('simulated Blobs outage');
        const value = objects.get(name + '/' + key);
        return value ? structuredClone(value) : null;
      },
      async get(key) { return objects.get(name + '/' + key)?.data || null; },
      async setJSON(key, data, options = {}) {
        const fullKey = name + '/' + key;
        const previous = objects.get(fullKey);
        writes.push({ key, options });
        if (options.onlyIfNew && previous) return { modified: false };
        if (options.onlyIfMatch && conflictOnce) { conflictOnce = false; return { modified: false }; }
        if (options.onlyIfMatch && options.onlyIfMatch !== previous?.etag) return { modified: false };
        const etag = 'etag-' + ++sequence;
        objects.set(fullKey, { data: structuredClone(data), etag });
        return { modified: true, etag };
      }
    };
  }
};
const handler = async request => (await import('../netlify/functions/state.mjs')).default(request);
const storage = require('../lib/storage');
const event = () => {
  // Simulate Netlify's native runtime-provided context with both cached and uncached origins.
  sdk.setEnvironmentContext({ siteID: 'test-site', token: 'test-only',
    edgeURL: 'https://unused.test', uncachedEdgeURL: 'https://unused.test' });
  return new Request('https://test.invalid/api/state');
};

test('native function uses Blobs context, migrates legacy data, and returns persistent JSON', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-lambda-'));
  process.env.KO_DB_FILE = path.join(tmp, 'must-not-exist.json');
  objects.set('knockout-sunday/arena-state', { data: { version: 15, manualLines: { '769D': { hsi: 1 } } }, etag: 'legacy' });
  try {
    const invocation = event();
    const response = await handler(invocation);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).schemaVersion, 2);
    assert.ok(objects.has('knockout-blitz-db/arena-state-v1-backup'));
    assert.ok(writes.some(w => w.key === 'arena-state-v2' && w.options.onlyIfNew));
    assert.ok(writes.some(w => w.options.onlyIfMatch));
    assert.equal(fs.existsSync(process.env.KO_DB_FILE), false);
    const readCount = reads;
    conflictOnce = true;
    const second = await handler(event());
    assert.equal(second.status, 200);
    assert.ok(reads >= readCount + 2, 'conditional write conflict must retry');
  } finally { delete process.env.KO_DB_FILE; fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('Blobs outage returns safe JSON 503 and never writes a disk fallback', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-outage-'));
  process.env.KO_DB_FILE = path.join(tmp, 'must-not-exist.json');
  const originalError = console.error;
  console.error = () => {};
  failReads = true;
  try {
    const response = await handler(event());
    assert.equal(response.status, 503);
    assert.match(response.headers.get('Content-Type'), /json/);
    assert.equal((await response.json()).error, 'Persistent database is unavailable. Please retry.');
    assert.equal(fs.existsSync(process.env.KO_DB_FILE), false);
    await assert.rejects(storage.readRawStateFromStorage(), /Persistent database/);
  } finally { failReads = false; console.error = originalError; delete process.env.KO_DB_FILE; fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('missing production context returns a controlled response without disk fallback', async () => {
  delete process.env.NETLIFY_BLOBS_CONTEXT;
  delete globalThis.netlifyBlobsContext;
  process.env.AWS_LAMBDA_FUNCTION_NAME = 'test-function';
  const originalError = console.error;
  console.error = () => {};
  try { assert.equal((await handler(new Request('https://test.invalid/api/state'))).status, 503); }
  finally { console.error = originalError; delete process.env.AWS_LAMBDA_FUNCTION_NAME; }
});

test('scheduled native function persists work when the sheet is unavailable', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('sheet unavailable in test'); };
  try {
    const invocation = event();
    const response = await (await import('../netlify/functions/scheduled-tick.mjs')).default(invocation);
    assert.equal(response.status, 200);
  } finally { global.fetch = originalFetch; }
});

test('native sandbox uses separate Blobs namespace and leaves live state untouched', async () => {
  const invocation = event();
  const liveBefore = structuredClone(objects.get('knockout-blitz-db/arena-state-v2'));
  const response = await handler(new Request(invocation.url, {
    method:'POST', headers:{'Content-Type':'application/json','x-admin-pin':require('../lib/auth').getConfiguredAdminPin(),'x-game-zone':'sandbox'},
    body:JSON.stringify({action:'admin_test_seed',scenario:'battle'})
  }));
  assert.equal(response.status,200);
  const data = await response.json();
  assert.equal(data.gameZone,'sandbox');
  assert.ok(objects.has('knockout-blitz-sandbox/arena-state-v2'));
  assert.deepEqual(objects.get('knockout-blitz-db/arena-state-v2'),liveBefore);
  assert.equal(objects.has('knockout-blitz-sandbox/arena-state-v1-backup'),false);
});
