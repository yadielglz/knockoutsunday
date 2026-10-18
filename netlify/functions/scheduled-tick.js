/**
 * Knockout Blitz — Netlify Scheduled Function (Runs every minute without an open browser)
 * Executes cutoffs, round starts/ends, Power Phase 350-pt entry check/draw,
 * automatic elimination checkpoints, daily closing, and Sunday 7:00 PM ET weekly rollover.
 */

const { transactState, parseGoogleSheetCSV } = require('../../lib/storage');
const { processScheduledBoundaries, reconcileSheetSnapshot } = require('../../lib/engine');
const { fetchSheetCsvFromGoogle } = require('../../lib/api-handler');

exports.handler = async () => {
  const nowMs = Date.now();
  let fetchedRows = null;

  try {
    const csvText = await fetchSheetCsvFromGoogle(
      'https://docs.google.com/spreadsheets/d/1hJuUd6UkzfWBeTywVM6Yi5g0BxJodsNLe0XHgt-9nOQ/edit?gid=1896995460'
    );
    fetchedRows = parseGoogleSheetCSV(csvText);
  } catch (e) {
    // Sheet fetch optional during scheduled tick
  }

  await transactState((state, txNowMs) => {
    if (fetchedRows && fetchedRows.length > 0) {
      reconcileSheetSnapshot(state, fetchedRows, txNowMs);
    }
    processScheduledBoundaries(state, txNowMs);
  }, { nowMs });

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, processedAt: new Date(nowMs).toISOString() })
  };
};

exports.config = {
  schedule: '* * * * *'
};
