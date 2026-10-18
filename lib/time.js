/**
 * Knockout Blitz — America/New_York Timezone, Schedule, Round & Boundary Utilities
 * Handles EDT/EST daylight saving transitions deterministically.
 */

const TIMEZONE = 'America/New_York';

const WEEKDAY_MAP = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

const dtfPartsCache = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

/**
 * Extract wall-clock components in America/New_York for any Date or epoch ms.
 */
function getEasternParts(dateOrMs) {
  const d = dateOrMs instanceof Date ? dateOrMs : new Date(dateOrMs);
  const parts = dtfPartsCache.formatToParts(d);
  const map = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0;
  const year = parseInt(map.year, 10);
  const month = parseInt(map.month, 10);
  const day = parseInt(map.day, 10);
  const minute = parseInt(map.minute, 10);
  const second = parseInt(map.second, 10);
  const weekdayShort = map.weekday; // 'Sun', 'Mon', ...
  const dayOfWeek = WEEKDAY_MAP[weekdayShort];
  const dateKey = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    ms: d.getMilliseconds(),
    weekdayShort,
    dayOfWeek,
    dateKey,
    epochMs: d.getTime()
  };
}

/**
 * Convert an America/New_York wall-clock date/time (year, month 1-12, day 1-31, hour 0-23, minute, second, ms)
 * into an exact UTC epoch timestamp (ms), accurately handling EDT (-04:00) and EST (-05:00) transitions.
 */
function easternWallTimeToEpochMs(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  // Start with an initial UTC guess assuming -04:00 offset
  const utcGuess = Date.UTC(year, month - 1, day, hour + 4, minute, second, ms);
  // Refine twice to handle DST boundary accurately
  let candidate = utcGuess;
  for (let i = 0; i < 3; i++) {
    const actual = getEasternParts(candidate);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second, ms);
    const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
    const diff = targetAsUtc - actualAsUtc;
    if (diff === 0) break;
    candidate += diff;
  }
  return candidate;
}

/**
 * Parse a YYYY-MM-DD dateKey and HH:MM(:SS) in America/New_York into epoch ms.
 */
function dateKeyAndTimeToEpochMs(dateKey, hour, minute = 0, second = 0, ms = 0) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return easternWallTimeToEpochMs(y, m, d, hour, minute, second, ms);
}

/**
 * Add calendar days to a YYYY-MM-DD dateKey in America/New_York.
 */
function addDaysToDateKey(dateKey, deltaDays) {
  const [y, m, d] = dateKey.split('-').map(Number);
  // Use noon UTC to avoid any midnight DST jump when stepping calendar days
  const noonUtc = new Date(Date.UTC(y, m - 1, d + deltaDays, 12, 0, 0));
  const yy = noonUtc.getUTCFullYear();
  const mm = String(noonUtc.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(noonUtc.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Compute the Weekly Competition Period [startMs, nextStartMs) for any timestamp.
 * Weekly period:
 * - Starts Sunday at 7:00 PM Eastern (19:00 America/New_York).
 * - Ends the following Sunday immediately before 7:00 PM Eastern.
 * - Sunday's daytime event (1:00 PM - 5:45 PM) belongs to the week ending that evening at 7:00 PM!
 */
function getWeeklyPeriodForTimestamp(nowMs) {
  const parts = getEasternParts(nowMs);
  // Find Sunday of the current calendar week
  const sundayDateKey = addDaysToDateKey(parts.dateKey, -parts.dayOfWeek);
  const thisSunday7PmMs = dateKeyAndTimeToEpochMs(sundayDateKey, 19, 0, 0, 0);

  let startSundayDateKey;
  let endSundayDateKey;

  if (nowMs >= thisSunday7PmMs) {
    // We are at or after Sunday 7:00 PM ET -> new week started this Sunday at 7:00 PM
    startSundayDateKey = sundayDateKey;
    endSundayDateKey = addDaysToDateKey(sundayDateKey, 7);
  } else {
    // We are before Sunday 7:00 PM ET (including Sunday 1:00 PM - 5:45 PM daytime event!)
    // Belongs to the week that started the PREVIOUS Sunday at 7:00 PM ET
    startSundayDateKey = addDaysToDateKey(sundayDateKey, -7);
    endSundayDateKey = sundayDateKey;
  }

  const startMs = dateKeyAndTimeToEpochMs(startSundayDateKey, 19, 0, 0, 0);
  const nextStartMs = dateKeyAndTimeToEpochMs(endSundayDateKey, 19, 0, 0, 0);
  const weekId = `week_${startSundayDateKey}_to_${endSundayDateKey}`;

  // The 7 daily event dateKeys belonging to this weekly period:
  // Monday (+1) through Sunday (+7, which is endSundayDateKey daytime before 7:00 PM!)
  const eventDateKeys = [];
  for (let offset = 1; offset <= 7; offset++) {
    eventDateKeys.push(addDaysToDateKey(startSundayDateKey, offset));
  }

  return {
    weekId,
    startSundayDateKey,
    endSundayDateKey,
    startMs,
    nextStartMs,
    startIso: new Date(startMs).toISOString(),
    nextStartIso: new Date(nextStartMs).toISOString(),
    eventDateKeys
  };
}

/**
 * Build the complete deterministic schedule for a given Eastern dateKey (YYYY-MM-DD).
 *
 * MONDAY–SATURDAY:
 * - Event starts: 11:00 AM ET
 * - Default deflection qualification window: 11:00 AM–1:00 PM ET (120 mins from actual start)
 * - Final stretch begins: 5:45 PM ET (17:45)
 * - Power phase: 5:45 PM–8:45 PM ET (17:45–20:45, THREE HOURS)
 * - Event ends: 8:45 PM ET (20:45)
 * - Elimination checkpoints: 6:15 PM, 6:45 PM, 7:15 PM, 7:45 PM, 8:15 PM, 8:45 PM
 * - Scheduled rounds: :10, :30, :50 each hour (5 mins each), from 11:10–11:15 AM through 8:30–8:35 PM
 *
 * SUNDAY EXCEPTION:
 * - Event starts: 1:00 PM ET (13:00)
 * - Default deflection qualification window: 1:00–3:00 PM ET (120 mins from actual start)
 * - Final stretch begins: 3:45 PM ET (15:45)
 * - Power phase: 4:45 PM–5:45 PM ET (16:45–17:45, ONE HOUR)
 * - Event ends: 5:45 PM ET (17:45)
 * - Elimination checkpoints: 4:15 PM, 4:45 PM, 5:15 PM, 5:45 PM
 * - Scheduled rounds: :10, :30, :50 each hour (5 mins each), from 1:10–1:15 PM through 5:30–5:35 PM
 */
function getDailyScheduleForDateKey(dateKey, customRounds = [], actualStartMs = null) {
  const noonMs = dateKeyAndTimeToEpochMs(dateKey, 12, 0, 0, 0);
  const parts = getEasternParts(noonMs);
  const isSunday = parts.dayOfWeek === 0;

  const scheduledStartMs = isSunday
    ? dateKeyAndTimeToEpochMs(dateKey, 13, 0, 0, 0)
    : dateKeyAndTimeToEpochMs(dateKey, 11, 0, 0, 0);

  const finalStretchStartMs = isSunday
    ? dateKeyAndTimeToEpochMs(dateKey, 15, 45, 0, 0)
    : dateKeyAndTimeToEpochMs(dateKey, 17, 45, 0, 0);

  const powerPhaseStartMs = isSunday
    ? dateKeyAndTimeToEpochMs(dateKey, 16, 45, 0, 0)
    : dateKeyAndTimeToEpochMs(dateKey, 17, 45, 0, 0);

  const eventCloseMs = isSunday
    ? dateKeyAndTimeToEpochMs(dateKey, 17, 45, 0, 0)
    : dateKeyAndTimeToEpochMs(dateKey, 20, 45, 0, 0);

  const effectiveStartMs = actualStartMs !== null && actualStartMs !== undefined ? actualStartMs : scheduledStartMs;
  const deflectionUnlockMs = effectiveStartMs + 120 * 60 * 1000;

  // Elimination checkpoints
  const checkpointHM = isSunday
    ? [
        [16, 15], // 4:15 PM (Before Power phase on Sunday!)
        [16, 45], // 4:45 PM (Coincides with Sunday Power phase entry)
        [17, 15], // 5:15 PM
        [17, 45]  // 5:45 PM (Coincides with Sunday closing)
      ]
    : [
        [18, 15], // 6:15 PM
        [18, 45], // 6:45 PM
        [19, 15], // 7:15 PM
        [19, 45], // 7:45 PM
        [20, 15], // 8:15 PM
        [20, 45]  // 8:45 PM (Coincides with Mon-Sat closing)
      ];

  const eliminationCheckpoints = checkpointHM.map(([h, m]) => {
    const ms = dateKeyAndTimeToEpochMs(dateKey, h, m, 0, 0);
    return {
      checkpointId: `chk_${dateKey}_${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`,
      hour: h,
      minute: m,
      label: formatEasternTimeLabel(ms),
      timestampMs: ms,
      isPowerPhase: ms >= powerPhaseStartMs
    };
  });

  // Scheduled Battle Rounds: :10, :30, :50 each hour that fit entirely inside [scheduledStartMs, eventCloseMs]
  const startHour = isSunday ? 13 : 11;
  const endHour = isSunday ? 17 : 20;
  const rounds = [];

  for (let h = startHour; h <= endHour; h++) {
    for (const m of [10, 30, 50]) {
      const rStartMs = dateKeyAndTimeToEpochMs(dateKey, h, m, 0, 0);
      const rEndMs = rStartMs + 5 * 60 * 1000; // 5 minutes
      const cutoffMs = rStartMs - 3 * 60 * 1000; // 3 minutes before round (:07, :27, :47)
      if (rStartMs >= scheduledStartMs && rEndMs <= eventCloseMs) {
        const roundId = `rnd_${dateKey}_${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`;
        rounds.push({
          roundId,
          dateKey,
          isCustom: false,
          hour: h,
          minute: m,
          startMs: rStartMs,
          endMs: rEndMs,
          cutoffMs,
          shieldProtectedUntilMs: rStartMs + 3 * 60 * 1000, // First 3 minutes protected
          isPowerPhase: rStartMs >= powerPhaseStartMs,
          label: `${formatEasternTimeLabel(rStartMs)}–${formatEasternTimeLabel(rEndMs)}`
        });
      }
    }
  }

  // Merge validated Admin custom rounds
  for (const cr of customRounds || []) {
    if (cr && cr.startMs && cr.endMs) {
      rounds.push({
        roundId: cr.roundId,
        dateKey,
        isCustom: true,
        startMs: cr.startMs,
        endMs: cr.endMs,
        cutoffMs: cr.startMs - 3 * 60 * 1000,
        announcedAtMs: cr.announcedAtMs,
        shieldProtectedUntilMs: cr.startMs + 3 * 60 * 1000,
        isPowerPhase: cr.startMs >= powerPhaseStartMs,
        label: `${formatEasternTimeLabel(cr.startMs)}–${formatEasternTimeLabel(cr.endMs)} (Bonus)`
      });
    }
  }

  rounds.sort((a, b) => a.startMs - b.startMs);

  return {
    dateKey,
    weekdayShort: parts.weekdayShort,
    dayOfWeek: parts.dayOfWeek,
    isSunday,
    scheduledStartMs,
    effectiveStartMs,
    deflectionUnlockMs,
    finalStretchStartMs,
    powerPhaseStartMs,
    powerPhaseDurationHours: isSunday ? 1 : 3,
    eventCloseMs,
    eliminationCheckpoints,
    rounds
  };
}

function formatEasternTimeLabel(epochMs) {
  const p = getEasternParts(epochMs);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour >= 12 ? 'PM' : 'AM';
  return `${h12}:${String(p.minute).padStart(2, '0')} ${ampm}`;
}

function formatEasternDateTime(epochMs) {
  const p = getEasternParts(epochMs);
  return `${p.weekdayShort} ${p.dateKey} ${formatEasternTimeLabel(epochMs)} ET`;
}

module.exports = {
  TIMEZONE,
  WEEKDAY_MAP,
  getEasternParts,
  easternWallTimeToEpochMs,
  dateKeyAndTimeToEpochMs,
  addDaysToDateKey,
  getWeeklyPeriodForTimestamp,
  getDailyScheduleForDateKey,
  formatEasternTimeLabel,
  formatEasternDateTime
};
