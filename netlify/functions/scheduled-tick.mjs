/** Native Netlify Functions API provides Blobs context for the scheduled job too. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { transactState, parseGoogleSheetCSV } = require('../../lib/storage');
const { processScheduledBoundaries, reconcileSheetSnapshot } = require('../../lib/engine');
const { fetchSheetCsvFromGoogle } = require('../../lib/api-handler');

export default async () => {
  const nowMs = Date.now();
  let rows = null;
  let sheetError = null;
  try {
    const text = await fetchSheetCsvFromGoogle(
      'https://docs.google.com/spreadsheets/d/1hJuUd6UkzfWBeTywVM6Yi5g0BxJodsNLe0XHgt-9nOQ/edit?gid=1896995460'
    );
    rows = parseGoogleSheetCSV(text);
    if (!rows.length) throw new Error('No store rows found in Google Sheet response.');
  } catch (error) { sheetError = error.message; }
  await transactState((state, txNowMs) => {
    if (sheetError) {
      state.sheetSyncMeta.lastAttemptAtMs = txNowMs;
      state.sheetSyncMeta.lastError = sheetError;
    }
    if (rows?.length) reconcileSheetSnapshot(state, rows, txNowMs);
    processScheduledBoundaries(state, txNowMs);
  }, { nowMs });
  return Response.json({ ok: true, processedAt: new Date(nowMs).toISOString() });
};
export const config = { schedule: '* * * * *' };
