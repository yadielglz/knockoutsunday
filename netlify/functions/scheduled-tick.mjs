/** Native Netlify Functions API provides Blobs context for the scheduled job too. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { transactState, parseGoogleSheetCSV } = require('../../lib/storage');
const { processScheduledBoundaries, reconcileSheetSnapshot } = require('../../lib/engine');
const { fetchSheetCsvFromGoogle } = require('../../lib/api-handler');

export default async () => {
  const nowMs = Date.now();
  let rows = null;
  try {
    const text = await fetchSheetCsvFromGoogle(
      'https://docs.google.com/spreadsheets/d/1hJuUd6UkzfWBeTywVM6Yi5g0BxJodsNLe0XHgt-9nOQ/edit?gid=1896995460'
    );
    rows = parseGoogleSheetCSV(text);
  } catch { /* Advance game boundaries even if the sheet is unavailable. */ }
  await transactState((state, txNowMs) => {
    if (rows?.length) reconcileSheetSnapshot(state, rows, txNowMs);
    processScheduledBoundaries(state, txNowMs);
  }, { nowMs });
  return Response.json({ ok: true, processedAt: new Date(nowMs).toISOString() });
};
export const config = { schedule: '* * * * *' };
