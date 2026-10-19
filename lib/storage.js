/**
 * Knockout Blitz — Durable Transactional Storage & Concurrency Control
 * Implements Sections 16, 17, 18, 19:
 * - Authoritative durable persistence via Netlify Blobs (strong consistency + ETag compare-and-swap retry)
 *   or durable disk JSON database with serialized mutex locking and atomic file writes.
 * - Automatic v1 -> v2 schema migration with recoverable backup preservation.
 * - Sanitizes sensitive store access codes before returning state to clients.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createInitialDatabaseState, processScheduledBoundaries } = require('./engine');
const { needsMigration, migrateV1ToV2 } = require('./migration');
const { getWeeklyStandings } = require('./engine');
const { getDailyScheduleForDateKey } = require('./time');
const { getEffectiveStoreAccessCode, getConfiguredAdminPin } = require('./auth');
const { parseDollarsToCents } = require('./scoring');

const DEFAULT_DB_FILE = path.join(process.cwd(), 'state-db.json');
const DEFAULT_BACKUP_FILE = path.join(process.cwd(), 'state-db.v1-backup.json');

// Serialized async mutex queue to guarantee atomic read-modify-write within a single Node process
let mutexPromise = Promise.resolve();

function withMutex(fn) {
  const next = mutexPromise.then(() => fn());
  mutexPromise = next.catch(() => {});
  return next;
}

function databasePath(options = {}) {
  const base = options.dbFilePath || process.env.KO_DB_FILE || DEFAULT_DB_FILE;
  return options.zone === 'sandbox' ? `${base}.sandbox` : base;
}

async function writeStateBackup(state, options = {}) {
  const id = `backup-${Date.now()}-${crypto.randomUUID()}`;
  const store = getNetlifyBlobStore(options.zone === 'sandbox' ? 'knockout-blitz-sandbox-backups' : 'knockout-blitz-backups');
  if (store) await store.setJSON(id, state, { onlyIfNew: true });
  else atomicWriteDiskFile(path.join(`${databasePath(options)}.backups`, `${id}.json`), state);
  return id;
}

function getNetlifyBlobStore(storeName = 'knockout-blitz-db') {
  if (!process.env.NETLIFY && !process.env.NETLIFY_BLOBS_CONTEXT &&
      !globalThis.netlifyBlobsContext && !process.env.USE_NETLIFY_BLOBS &&
      !process.env.AWS_LAMBDA_FUNCTION_NAME) return null;
  // A production storage failure must never create a separate local database.
  const { getStore } = require('@netlify/blobs');
  return getStore({ name: storeName, consistency: 'strong' });
}

/**
 * Read raw state from durable storage (Netlify Blobs or Disk DB),
 * performing v1 -> v2 migration with backup if needed.
 */
async function readRawStateFromStorage(options = {}) {
  const dbFilePath = databasePath(options);
  const backupFilePath = options.backupFilePath || process.env.KO_BACKUP_FILE || DEFAULT_BACKUP_FILE;
  const nowMs = options.nowMs || Date.now();

  const blobStore = getNetlifyBlobStore(options.zone === 'sandbox' ? 'knockout-blitz-sandbox' : 'knockout-blitz-db');
  if (blobStore) {
    try {
      const entry = await blobStore.getWithMetadata('arena-state-v2', { type: 'json' });
      if (entry && entry.data) {
        return { state: entry.data, etag: entry.etag, backend: 'netlify-blobs' };
      }
      // Check if v1 legacy store exists on Netlify Blobs
      const legacyStore = options.zone === 'sandbox' ? null : getNetlifyBlobStore('knockout-sunday');
      if (legacyStore) {
        const legacyData = await legacyStore.get('arena-state', { type: 'json' });
        if (legacyData) {
          await blobStore.setJSON('arena-state-v1-backup', legacyData, { onlyIfNew: true });
          const migrated = migrateV1ToV2(legacyData, nowMs);
          await blobStore.setJSON('arena-state-v2', migrated, { onlyIfNew: true });
          const saved = await blobStore.getWithMetadata('arena-state-v2', { type: 'json' });
          if (!saved?.data || !saved.etag) throw new Error('Cannot read initialized database.');
          return { state: saved.data, etag: saved.etag, backend: 'netlify-blobs' };
        }
      }
      const initial = createInitialDatabaseState(nowMs);
      await blobStore.setJSON('arena-state-v2', initial, { onlyIfNew: true });
      const saved = await blobStore.getWithMetadata('arena-state-v2', { type: 'json' });
      if (!saved?.data || !saved.etag) throw new Error('Cannot read initialized database.');
      return { state: saved.data, etag: saved.etag, backend: 'netlify-blobs' };
    } catch (blobErr) {
      throw new Error('Persistent database is unavailable.', { cause: blobErr });
    }
  }

  // Durable Disk Storage (state-db.json)
  if (fs.existsSync(dbFilePath)) {
    const rawText = fs.readFileSync(dbFilePath, 'utf8');
    const parsed = JSON.parse(rawText);
    if (needsMigration(parsed)) {
      if (!fs.existsSync(backupFilePath)) {
        fs.writeFileSync(backupFilePath, JSON.stringify(parsed, null, 2), 'utf8');
      }
      const migrated = migrateV1ToV2(parsed, nowMs);
      atomicWriteDiskFile(dbFilePath, migrated);
      return { state: migrated, etag: null, backend: 'disk-file' };
    }
    return { state: parsed, etag: null, backend: 'disk-file' };
  }

  const initial = createInitialDatabaseState(nowMs);
  atomicWriteDiskFile(dbFilePath, initial);
  return { state: initial, etag: null, backend: 'disk-file' };
}

function atomicWriteDiskFile(filePath, dataObj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(dataObj, null, 2), 'utf8');
  try {
    fs.renameSync(tmpFile, filePath);
  } catch (renameErr) {
    // On Windows, renameSync can occasionally fail if an antivirus scanner holds a brief handle; copy+unlink fallback
    fs.writeFileSync(filePath, JSON.stringify(dataObj, null, 2), 'utf8');
    try {
      fs.unlinkSync(tmpFile);
    } catch (e) {}
  }
}

/**
 * Execute an atomic read-modify-write transaction against the durable database.
 * Retries automatically on Netlify Blobs ETag conflict so concurrent requests never overwrite each other.
 */
async function transactState(mutatorFn, options = {}) {
  return withMutex(async () => {
    const dbFilePath = databasePath(options);
    const maxRetries = 5;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const { state, etag, backend } = await readRawStateFromStorage(options);
      const nowMs = options.zone === 'sandbox' && state.sandboxClockMs ? state.sandboxClockMs : (options.nowMs || Date.now());

      // Run mutator function on state
      const result = await mutatorFn(state, nowMs);

      state.version = (Number(state.version) || 1) + 1;
      state.updatedAt = new Date(nowMs).toISOString();

      if (backend === 'netlify-blobs') {
        const blobStore = getNetlifyBlobStore(options.zone === 'sandbox' ? 'knockout-blitz-sandbox' : 'knockout-blitz-db');
        if (blobStore) {
          if (!etag) throw new Error('Database read did not provide a concurrency token.');
          const writeOpts = { onlyIfMatch: etag };
          const writeRes = await blobStore.setJSON('arena-state-v2', state, writeOpts);
          if (etag && writeRes && writeRes.modified === false) {
            // Concurrent modification detected! Retry transaction with fresh state
            if (attempt < maxRetries) continue;
            throw new Error('Concurrent state update conflict after maximum retries.');
          }
          return { state, result, backend };
        }
      }

      atomicWriteDiskFile(dbFilePath, state);
      return { state, result, backend };
    }
  });
}

/**
 * Build a sanitized public view of the state with computed schedule, weekly standings,
 * and auth configuration status (never exposing raw storeAccessCodes or secrets).
 */
function buildPublicStateView(state, nowMs = Date.now()) {
  processScheduledBoundaries(state, nowMs);

  const clone = JSON.parse(JSON.stringify(state));
  // Never expose raw storeAccessCodes or full legacyBackup in public payload
  delete clone.storeAccessCodes;
  if (clone.migrationMeta) {
    clone.migrationMeta = {
      migratedFromV1At: clone.migrationMeta.migratedFromV1At,
      flaggedLegacyRecordsCount: (clone.migrationMeta.flaggedLegacyRecords || []).length,
      flaggedLegacyRecords: clone.migrationMeta.flaggedLegacyRecords || [],
      hasLegacyBackup: Boolean(clone.migrationMeta.legacyBackup)
    };
  }

  const configuredStoreAuth = {};
  for (const storeId of Object.keys(state.stores || {})) {
    configuredStoreAuth[storeId] = Boolean(getEffectiveStoreAccessCode(state, storeId));
  }

  const evt = state.currentEvent;
  const schedule = evt
    ? getDailyScheduleForDateKey(evt.dateKey, evt.customRounds, evt.actualStartMs || evt.scheduledStartMs)
    : null;

  const weeklyStandings = getWeeklyStandings(state);

  return {
    ...clone,
    serverNowMs: nowMs,
    serverNowIso: new Date(nowMs).toISOString(),
    authStatus: {
      adminPinConfigured: Boolean(getConfiguredAdminPin()),
      configuredStoreAuth
    },
    computedSchedule: schedule,
    weeklyStandings
  };
}

/**
 * Parse Google Sheet CSV text into store rows (matching by store code).
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseNumberCell(val) {
  if (!val || String(val).includes('#DIV/0!') || String(val).includes('#VALUE!')) return 0;
  const cleaned = String(val).replace(/[$,%\s]/g, '');
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : 0;
}

function parseGoogleSheetCSV(csvText) {
  const lines = String(csvText || '')
    .split(/\r?\n/)
    .filter(l => l.trim().length > 0);
  const rows = [];
  const reportDate = String(csvText).match(/report\s*date[^\d\n]*(\d{4}-\d{2}-\d{2})/i);
  if (reportDate) rows.reportDateKey = reportDate[1];

  for (const line of lines) {
    const cols = parseCSVLine(line);
    const colB = (cols[1] || '').trim();
    if (!colB) continue;

    const match = colB.match(/^([0-9A-Z]{3,5})\s*[-—]\s*(.+)$/i);
    if (match) {
      const id = match[1].toUpperCase();
      rows.push({
        id,
        nrGoal: parseNumberCell(cols[4]),
        netRev: parseNumberCell(cols[5]),
        accGoal: parseNumberCell(cols[7]),
        acc: cols[8] || '0',
        accCents: parseDollarsToCents(cols[8] || '0'),
        postGoal: parseNumberCell(cols[10]),
        totalPP: parseNumberCell(cols[11]),
        vl: Math.trunc(parseNumberCell(cols[13])),
        bts: Math.trunc(parseNumberCell(cols[14])),
        hsi: Math.trunc(parseNumberCell(cols[15])),
        visa: Math.trunc(parseNumberCell(cols[16])),
        preOrders: Math.trunc(parseNumberCell(cols[17]))
      });
    }
  }
  return rows;
}

module.exports = {
  writeStateBackup,
  readRawStateFromStorage,
  transactState,
  buildPublicStateView,
  parseGoogleSheetCSV
};
