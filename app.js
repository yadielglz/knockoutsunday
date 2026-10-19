/**
 * 🥊 KNOCKOUT BLITZ 🔥 — Frontend Application Client
 * Authoritative Server State Client (America/New_York Timezone)
 * Browser storage is used strictly as a read-only display cache and session token store.
 * Failed/offline requests NEVER create local combat actions.
 */

const CACHE_KEY = 'knockout_blitz_view_cache_v2';
const ADMIN_TOKEN_KEY = 'knockout_blitz_admin_token';
const STORE_AUTH_KEY = 'knockout_blitz_store_auth';

const ROSTER_ORDER = ['843D', '693D', '561D', '5383', '769D', '5733', '582D', '892E', '697D'];

let serverState = null;
let serverClockOffsetMs = 0;

let clientSession = {
  isAdmin: false,
  adminToken: '',
  adminPin: '',
  storeId: '',
  storeToken: '',
  soundEnabled: true,
  activeView: 'arena', // 'arena' | 'weekly' | 'ledger'
  activeAdminTab: 'sales', // 'sales' | 'lifecycle' | 'audit' | 'auth'
  filter: 'all',
  sortBy: 'available_desc',
  lastCombatActionId: null
};

// Web Audio API Sound Effects
const SoundFX = {
  ctx: null,
  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
  },
  playKO() {
    if (!clientSession.soundEnabled) return;
    try {
      this.init();
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(150, now);
      osc.frequency.exponentialRampToValueAtTime(32, now + 0.25);
      gain.gain.setValueAtTime(0.5, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.3);
    } catch (e) {}
  },
  playRevive() {
    if (!clientSession.soundEnabled) return;
    try {
      this.init();
      const now = this.ctx.currentTime;
      [330, 440, 554.37, 659.25].forEach((freq, idx) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + idx * 0.07);
        gain.gain.setValueAtTime(0.2, now + idx * 0.07);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.07 + 0.3);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now + idx * 0.07);
        osc.stop(now + idx * 0.07 + 0.32);
      });
    } catch (e) {}
  }
};

function getServerNowMs() {
  return Date.now() + serverClockOffsetMs;
}

function formatBpDisplay(bp) {
  const val = Number(bp || 0);
  const sign = val < 0 ? '-' : '';
  const abs = Math.abs(val);
  const whole = Math.floor(abs / 100);
  const rem = abs % 100;
  if (rem === 0) return `${sign}${whole.toLocaleString('en-US')}`;
  const dec = rem % 10 === 0 ? String(rem / 10) : String(rem).padStart(2, '0');
  return `${sign}${whole.toLocaleString('en-US')}.${dec}`;
}

function formatCentsDisplay(cents) {
  const c = Number(cents || 0);
  const abs = Math.abs(c);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  if (rem === 0) return `$${dollars.toLocaleString('en-US')}`;
  return `$${dollars.toLocaleString('en-US')}.${String(rem).padStart(2, '0')}`;
}

function formatCountdown(msRemaining) {
  const sec = Math.max(0, Math.ceil(msRemaining / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatEtTime(epochMs) {
  if (!epochMs) return '--:--';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(new Date(epochMs));
}

function formatEtClock(epochMs) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(new Date(epochMs));
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function makeIdempotencyKey(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// Session & Cache Loader
function loadClientSession() {
  try {
    const savedAdmin = sessionStorage.getItem(ADMIN_TOKEN_KEY);
    if (savedAdmin) {
      const parsed = JSON.parse(savedAdmin);
      clientSession.isAdmin = true;
      clientSession.adminToken = parsed.adminToken || '';
      clientSession.adminPin = parsed.adminPin || '';
    }
    const savedStore = localStorage.getItem(STORE_AUTH_KEY) || sessionStorage.getItem(STORE_AUTH_KEY);
    if (savedStore) {
      const parsed = JSON.parse(savedStore);
      clientSession.storeId = parsed.storeId || '843D';
      clientSession.storeToken = parsed.storeToken || '';
    } else {
      clientSession.storeId = '843D';
    }
    const cachedView = localStorage.getItem(CACHE_KEY);
    if (cachedView) {
      serverState = JSON.parse(cachedView);
    }
  } catch (e) {
    if (!clientSession.storeId) clientSession.storeId = '843D';
  }
}

// Fetch authoritative state from /api/state
async function fetchAuthoritativeState() {
  const syncDot = document.getElementById('sync-dot');
  const syncStatusText = document.getElementById('sync-status-text');
  const syncIcon = document.getElementById('sync-icon');

  syncIcon?.classList.add('animate-spin');
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    applyServerState(data);
    syncDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400';
    syncStatusText.textContent = 'Authoritative DB Live';
  } catch (err) {
    syncDot.className = 'w-2.5 h-2.5 rounded-full bg-red-400';
    syncStatusText.textContent = 'Server Offline (Read-Only)';
  } finally {
    syncIcon?.classList.remove('animate-spin');
  }
}

function applyServerState(data) {
  if (!data || typeof data !== 'object') return;
  if (data.serverNowMs) {
    serverClockOffsetMs = data.serverNowMs - Date.now();
  }

  // Trigger FX banner if a brand-new combat action arrived
  const prevLastId = clientSession.lastCombatActionId;
  const latestCombat = Array.isArray(data.combatLog) && data.combatLog.length > 0
    ? data.combatLog[data.combatLog.length - 1]
    : null;

  serverState = data;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch (e) {}

  if (latestCombat && prevLastId && latestCombat.actionId !== prevLastId) {
    if (latestCombat.type === 'ATTACK') {
      SoundFX.playKO();
      const atkName = data.stores?.[latestCombat.attackerId]?.name || latestCombat.attackerId;
      const tgtName = data.stores?.[latestCombat.targetId]?.name || latestCombat.targetId;
      triggerBannerFX(
        latestCombat.resultingKnockout ? 'KO' : 'HIT',
        atkName,
        tgtName,
        `${latestCombat.attackType} (-${latestCombat.effectiveDamagePoints} pts)${latestCombat.resultingKnockout ? ' — KNOCKOUT!' : ''}`
      );
    } else if (latestCombat.type === 'REVIVE') {
      SoundFX.playRevive();
      const stName = data.stores?.[latestCombat.storeId]?.name || latestCombat.storeId;
      triggerBannerFX('REVIVE', stName, stName, `Self-Revived (-${latestCombat.costPoints} pts)`);
    }
  }
  if (latestCombat) {
    clientSession.lastCombatActionId = latestCombat.actionId;
  }

  renderAll();
}

// Send POST action to /api/state (Never mutates combat state locally on failure!)
async function postServerAction(payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (clientSession.adminToken) headers['x-admin-token'] = clientSession.adminToken;
  if (clientSession.adminPin) headers['x-admin-pin'] = clientSession.adminPin;
  if (clientSession.storeToken) headers['x-store-token'] = clientSession.storeToken;

  const res = await fetch('/api/state', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Server rejected action (HTTP ${res.status})`);
  }
  applyServerState(data);
  return data;
}

function triggerBannerFX(type, actorName, targetName, detailText) {
  const overlay = document.getElementById('fx-overlay');
  const banner = document.getElementById('fx-banner');
  const emoji = document.getElementById('fx-emoji');
  const title = document.getElementById('fx-title');
  const subtitle = document.getElementById('fx-subtitle');

  document.body.classList.remove('shake-screen');
  void document.body.offsetWidth;
  document.body.classList.add('shake-screen');

  if (type === 'KO') {
    banner.className = 'transform scale-100 transition-transform duration-300 text-center px-10 py-8 rounded-3xl border-2 border-red-500 bg-gradient-to-b from-red-950/95 via-zinc-950/95 to-black/95 shadow-2xl';
    emoji.textContent = '🥊💥';
    title.className = 'font-display text-6xl tracking-wider uppercase text-red-400';
    title.textContent = 'KNOCKOUT!';
    subtitle.innerHTML = `<span class="text-white font-extrabold">${escapeHtml(actorName)}</span> knocked out <span class="text-red-400 font-extrabold">${escapeHtml(targetName)}</span>!<div class="text-sm text-amber-300 mt-1">${escapeHtml(detailText)}</div>`;
  } else if (type === 'HIT') {
    banner.className = 'transform scale-100 transition-transform duration-300 text-center px-10 py-8 rounded-3xl border-2 border-magenta bg-gradient-to-b from-magenta/30 via-zinc-950/95 to-black/95 shadow-2xl';
    emoji.textContent = '⚔️🔥';
    title.className = 'font-display text-5xl tracking-wider uppercase text-amber-300';
    title.textContent = 'DIRECT HIT!';
    subtitle.innerHTML = `<span class="text-white font-extrabold">${escapeHtml(actorName)}</span> hit <span class="text-pink-300 font-extrabold">${escapeHtml(targetName)}</span>!<div class="text-sm text-zinc-200 mt-1">${escapeHtml(detailText)}</div>`;
  } else {
    banner.className = 'transform scale-100 transition-transform duration-300 text-center px-10 py-8 rounded-3xl border-2 border-emerald-400 bg-gradient-to-b from-emerald-950/95 via-zinc-950/95 to-black/95 shadow-2xl';
    emoji.textContent = '⚡🔥';
    title.className = 'font-display text-5xl tracking-wider uppercase text-emerald-400';
    title.textContent = 'BACK IN THE RING!';
    subtitle.innerHTML = `<span class="text-emerald-300 font-extrabold">${escapeHtml(actorName)}</span>: ${escapeHtml(detailText)}`;
  }

  overlay.classList.remove('opacity-0');
  overlay.classList.add('opacity-100');
  setTimeout(() => {
    overlay.classList.remove('opacity-100');
    overlay.classList.add('opacity-0');
  }, 2400);
}

// Live 1-Second Telemetry & Countdown Ticker
function updateTelemetryTick() {
  const nowMs = getServerNowMs();
  const clockEl = document.getElementById('et-clock-badge');
  if (clockEl) clockEl.textContent = `${formatEtClock(nowMs)} ET`;

  if (!serverState || !serverState.currentEvent || !serverState.computedSchedule) return;

  const evt = serverState.currentEvent;
  const sched = serverState.computedSchedule;
  const activeRoundId = evt.activeRoundId;
  const activeRound = activeRoundId ? evt.roundStates?.[activeRoundId] : null;
  const isRoundOpen = Boolean(activeRound && activeRound.status === 'OPEN' && nowMs >= activeRound.startMs && nowMs < activeRound.endMs);

  // Top live battle round banner
  const topRoundBanner = document.getElementById('battle-window-banner');
  const topRoundTimer = document.getElementById('battle-countdown-timer');
  const topRoundTitle = document.getElementById('active-round-banner-title');
  if (isRoundOpen) {
    topRoundBanner?.classList.remove('hidden');
    if (topRoundTimer) topRoundTimer.textContent = formatCountdown(activeRound.endMs - nowMs);
    if (topRoundTitle) topRoundTitle.textContent = `BATTLE ROUND LIVE (${activeRound.label}) — MAX 2 ATTACKS PER STORE!`;
  } else {
    topRoundBanner?.classList.add('hidden');
  }

  // Next Round Telemetry
  const nextRoundEl = document.getElementById('telemetry-next-round');
  const nextRoundSub = document.getElementById('telemetry-next-round-sub');
  if (isRoundOpen) {
    nextRoundEl.textContent = `LIVE (${formatCountdown(activeRound.endMs - nowMs)})`;
    nextRoundEl.className = 'font-mono text-xl font-extrabold text-emerald-400 mt-1 animate-pulse';
    nextRoundSub.textContent = `Active: ${activeRound.label}`;
  } else {
    const upcomingRound = (sched.rounds || []).find(r => r.startMs > nowMs && r.endMs <= sched.eventCloseMs);
    if (upcomingRound) {
      nextRoundEl.textContent = formatCountdown(upcomingRound.startMs - nowMs);
      nextRoundEl.className = 'font-mono text-xl font-extrabold text-white mt-1';
      nextRoundSub.textContent = `Next: ${upcomingRound.label} ET`;
    } else {
      nextRoundEl.textContent = 'Done';
      nextRoundEl.className = 'font-mono text-xl font-extrabold text-zinc-500 mt-1';
      nextRoundSub.textContent = 'No further rounds today';
    }
  }

  // Next 3-Min Sales Cutoff Telemetry (:07, :27, :47)
  const nextCutoffEl = document.getElementById('telemetry-next-cutoff');
  const nextCutoffSub = document.getElementById('telemetry-next-cutoff-sub');
  const upcomingCutoffRound = (sched.rounds || []).find(r => r.cutoffMs > nowMs && r.endMs <= sched.eventCloseMs);
  if (upcomingCutoffRound) {
    nextCutoffEl.textContent = formatCountdown(upcomingCutoffRound.cutoffMs - nowMs);
    nextCutoffSub.textContent = `Cutoff ${formatEtTime(upcomingCutoffRound.cutoffMs)} for ${formatEtTime(upcomingCutoffRound.startMs)} round`;
  } else {
    nextCutoffEl.textContent = 'Passed';
    nextCutoffSub.textContent = 'Pending sales held at close';
  }

  // Deflection 120m Telemetry
  const deflectEl = document.getElementById('telemetry-deflection');
  const deflectSub = document.getElementById('telemetry-deflection-sub');
  if (nowMs >= sched.powerPhaseStartMs || evt.phase === 'POWER_PHASE') {
    deflectEl.textContent = 'Disabled';
    deflectSub.textContent = 'Disabled during Power Phase';
  } else if (nowMs < evt.deflectionUnlockMs) {
    deflectEl.textContent = formatCountdown(evt.deflectionUnlockMs - nowMs);
    deflectSub.textContent = `Qualifying window until ${formatEtTime(evt.deflectionUnlockMs)} ET`;
  } else {
    deflectEl.textContent = 'UNLOCKED';
    deflectSub.textContent = 'Requires 2 survivals + 1,350 pts at round start';
  }

  // Power Phase Telemetry
  const powerEl = document.getElementById('telemetry-power-phase');
  const powerSub = document.getElementById('telemetry-power-phase-sub');
  if (nowMs < sched.powerPhaseStartMs) {
    powerEl.textContent = formatCountdown(sched.powerPhaseStartMs - nowMs);
    powerSub.textContent = `${sched.isSunday ? '1-Hr Power Phase (4:45 PM)' : '3-Hr Power Hours (5:45 PM)'} • 350 Min`;
  } else if (nowMs < sched.eventCloseMs) {
    powerEl.textContent = `ACTIVE (${formatCountdown(sched.eventCloseMs - nowMs)})`;
    powerSub.textContent = 'Revivals & Deflection disabled • Shields active';
  } else {
    powerEl.textContent = 'Ended';
    powerSub.textContent = `Closed at ${formatEtTime(sched.eventCloseMs)} ET`;
  }

  // Next Automatic Elimination Checkpoint Telemetry
  const chkEl = document.getElementById('telemetry-next-checkpoint');
  const chkSub = document.getElementById('telemetry-next-checkpoint-sub');
  const nextChk = (sched.eliminationCheckpoints || []).find(c => c.timestampMs > nowMs);
  if (evt.pendingEliminationTie) {
    chkEl.textContent = 'TIE PAUSED';
    chkSub.textContent = `Awaiting Admin at ${evt.pendingEliminationTie.checkpointLabel}`;
  } else if (nextChk) {
    chkEl.textContent = formatCountdown(nextChk.timestampMs - nowMs);
    chkSub.textContent = `Next elimination at ${nextChk.label} ET`;
  } else {
    chkEl.textContent = 'Complete';
    chkSub.textContent = 'All checkpoints processed';
  }
}

// Render Full UI
function renderAll() {
  if (!serverState) return;
  const nowMs = getServerNowMs();
  const evt = serverState.currentEvent;
  const sched = serverState.computedSchedule;
  const storesMap = serverState.stores || {};
  const storesList = ROSTER_ORDER.map(id => storesMap[id]).filter(Boolean);

  // Header & Phase Badges
  document.getElementById('district-badge').textContent = serverState.districtName || 'PHOENIX DISTRICT';
  const phaseBadge = document.getElementById('phase-badge');
  const phaseLabelMap = {
    PRE_EVENT: '⏳ PRE-EVENT',
    REGULAR_HOURS: '🟢 REGULAR HOURS',
    FINAL_STRETCH: '🔥 FINAL STRETCH',
    POWER_PHASE: `⚡ POWER HOURS (${sched?.powerPhaseDurationHours || 3}H)`,
    CLOSED: evt.status === 'ENDED_DRAW' ? '⚠️ ENDED (DRAW)' : '🏁 DAILY EVENT CLOSED'
  };
  phaseBadge.textContent = phaseLabelMap[evt.phase] || evt.phase;

  // Sheet Freshness
  const syncTimeText = document.getElementById('sync-time-text');
  const lastSheetMs = serverState.sheetSyncMeta?.lastSuccessAtMs;
  const unresolvedIssues = (serverState.reconciliationIssues || []).filter(i => !i.resolved).length;
  syncTimeText.textContent = lastSheetMs
    ? `Sheet: ${formatEtTime(lastSheetMs)} ET${unresolvedIssues > 0 ? ` (${unresolvedIssues} issue)` : ''}`
    : 'Sheet: Ready to sync';

  // Admin Visibility
  const isAdmin = clientSession.isAdmin;
  document.querySelectorAll('.admin-only').forEach(el => {
    if (isAdmin) el.classList.remove('hidden');
    else el.classList.add('hidden');
  });
  document.getElementById('admin-lock-icon').textContent = isAdmin ? '🔓' : '🔒';
  document.getElementById('admin-lock-label').textContent = isAdmin ? 'Exit Admin' : 'Admin';

  // Store Selector Header Pill
  if (!clientSession.storeId || !storesMap[clientSession.storeId]) {
    clientSession.storeId = ROSTER_ORDER[0];
  }
  const myStore = storesMap[clientSession.storeId] || null;
  document.getElementById('my-store-pill-emoji').textContent = myStore ? myStore.emoji : '🏪';
  document.getElementById('my-store-pill-name').textContent = myStore ? myStore.name : 'Select Store...';
  document.getElementById('my-store-auth-label').textContent = 'Playing As Store';

  // Standing count
  const standingStores = storesList.filter(s => s.status === 'STANDING');
  document.getElementById('stat-standing').textContent = standingStores.length;
  document.getElementById('stat-total-stores').textContent = `/ ${storesList.length} Standing`;
  document.getElementById('count-all').textContent = storesList.length;

  // Announcement Banner
  const annBanner = document.getElementById('announcement-banner');
  if (serverState.announcement?.active && serverState.announcement?.text) {
    annBanner.classList.remove('hidden');
    document.getElementById('announcement-text').textContent = serverState.announcement.text;
  } else {
    annBanner.classList.add('hidden');
  }

  // Draw / Qualifiers / Tie Banners
  const drawBanner = document.getElementById('draw-banner');
  const qualifiersBanner = document.getElementById('qualifiers-banner');
  const tieBanner = document.getElementById('tie-alert-banner');

  if (evt.status === 'ENDED_DRAW') {
    drawBanner.classList.remove('hidden');
    document.getElementById('draw-banner-reason').textContent =
      evt.drawReason || 'All remaining standing stores were below 350 available points at Power Phase entry.';
  } else {
    drawBanner.classList.add('hidden');
  }

  if (evt.status === 'ENDED_NORMAL') {
    qualifiersBanner.classList.remove('hidden');
    const qNames = (evt.dailyQualifiers || []).map(id => storesMap[id]?.name || id);
    document.getElementById('qualifiers-banner-list').textContent =
      qNames.length > 0 ? qNames.join(' • ') : 'No surviving qualifiers';
  } else {
    qualifiersBanner.classList.add('hidden');
  }

  if (evt.pendingEliminationTie) {
    tieBanner.classList.remove('hidden');
    const cNames = evt.pendingEliminationTie.candidateSnapshots
      .map(c => `${c.name} (${c.availablePoints} avail / ${c.salesEarnedPoints} sales pts)`)
      .join(' vs ');
    document.getElementById('tie-alert-text').textContent = `Checkpoint ${evt.pendingEliminationTie.checkpointLabel} ET tied on both Available Points and Sales-Earned Points: ${cNames}.`;
  } else {
    tieBanner.classList.add('hidden');
  }

  renderStoreCards(storesList, evt, sched, nowMs);
  renderWeeklyStandingsView();
  renderFullLedgerAndScheduleView(storesList, evt, sched, nowMs);
  renderStoreCombatDeck(storesList, myStore, evt, sched, nowMs);
  if (isAdmin) {
    renderAdminPanel(storesList, evt, sched, nowMs);
  }
  renderActivityFeed(storesMap);
  updateTelemetryTick();
}

function renderStoreCards(storesList, evt, sched, nowMs) {
  const grid = document.getElementById('stores-grid');
  let filtered = [...storesList];
  if (clientSession.filter === 'standing') filtered = filtered.filter(s => s.status === 'STANDING');
  if (clientSession.filter === 'eliminated') filtered = filtered.filter(s => s.status === 'KNOCKED_OUT');

  filtered.sort((a, b) => {
    if (clientSession.sortBy === 'available_desc') return b.availableBp - a.availableBp || b.totalEarnedBp - a.totalEarnedBp;
    if (clientSession.sortBy === 'earned_desc') return b.totalEarnedBp - a.totalEarnedBp || b.availableBp - a.availableBp;
    if (clientSession.sortBy === 'standing_first') {
      if (a.status !== b.status) return a.status === 'STANDING' ? -1 : 1;
      return b.availableBp - a.availableBp;
    }
    return ROSTER_ORDER.indexOf(a.id) - ROSTER_ORDER.indexOf(b.id);
  });

  const activeRound = evt.activeRoundId ? evt.roundStates?.[evt.activeRoundId] : null;
  const isRoundOpen = Boolean(activeRound && activeRound.status === 'OPEN' && nowMs >= activeRound.startMs && nowMs < activeRound.endMs);

  grid.innerHTML = filtered.map(store => {
    const isStanding = store.status === 'STANDING';
    const isMyStore = clientSession.storeId === store.id;
    const isQualifier = (evt.dailyQualifiers || []).includes(store.id);
    const attacksUsed = isRoundOpen ? Number(activeRound.attacksByStore?.[store.id] || 0) : 0;

    const sheetReport = serverState.latestSheetReport;
    const sheetRow = sheetReport?.rows?.find(r => r.id === store.id);
    // Deflection status
    const deflectActive = isRoundOpen && Boolean(activeRound.deflectionSnapshot?.[store.id]) && store.deflection.activeForRoundId === activeRound.roundId && store.deflection.brokenInRoundId !== activeRound.roundId;
    const deflectBroken = isRoundOpen && store.deflection.brokenInRoundId === activeRound.roundId;

    // Shield status
    let shieldStatusLabel = 'None';
    let shieldBadgeClass = 'bg-zinc-800 text-zinc-400';
    if (store.shield.activeRoundId && store.shield.protectedUntilMs && nowMs < store.shield.protectedUntilMs) {
      shieldStatusLabel = `🛡️ ACTIVE (${formatCountdown(store.shield.protectedUntilMs - nowMs)})`;
      shieldBadgeClass = 'bg-cyan-500/25 text-cyan-300 border border-cyan-400/50 animate-pulse';
    } else if (store.shield.queuedForRoundId) {
      shieldStatusLabel = `🛡️ QUEUED (${store.shield.queuedForRoundId.slice(-4)})`;
      shieldBadgeClass = 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30';
    } else if (store.shield.lastExpiredRoundId) {
      shieldStatusLabel = 'Expired';
    }

    return `
      <div class="store-card relative rounded-2xl border p-4 flex flex-col justify-between ${
        !isStanding
          ? 'is-eliminated border-red-500/40'
          : isQualifier
          ? 'is-survivor bg-arena-card'
          : isMyStore
          ? 'bg-arena-card border-magenta shadow-lg shadow-magenta/10'
          : 'bg-arena-card border-arena-border hover:border-magenta/50'
      }">
        <div>
          <!-- Header -->
          <div class="flex items-start justify-between gap-2 mb-3">
            <div class="flex items-center gap-2.5">
              <div class="w-11 h-11 rounded-xl flex items-center justify-center text-2xl border ${
                !isStanding ? 'bg-red-950/50 border-red-500/30 grayscale' : 'bg-arena-elevated border-white/10'
              }">
                ${!isStanding ? '💀' : store.emoji}
              </div>
              <div>
                <div class="flex items-center gap-1.5 flex-wrap">
                  <h3 class="font-display text-2xl tracking-wide leading-none ${!isStanding ? 'line-through text-zinc-400' : 'text-white'}">
                    ${escapeHtml(store.name)}
                  </h3>
                  ${isMyStore ? '<span class="text-[9px] px-2 py-0.5 rounded-full bg-magenta text-white font-extrabold uppercase">YOUR STORE</span>' : ''}
                  ${isQualifier ? '<span class="text-[9px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-400/40 font-extrabold uppercase">🏅 QUALIFIER</span>' : ''}
                </div>
                <div class="flex items-center gap-2 mt-1 text-[10px] text-zinc-400">
                  <span>Deflection Survivals (0–120m): <strong class="${store.deflection.qualifiedForDay ? 'text-cyan-300' : 'text-zinc-200'}">${store.deflection.survivedAttacksInFirst120}/2</strong></span>
                  <span>•</span>
                  <span>Round Atks: <strong class="text-amber-300">${attacksUsed}/2</strong></span>
                </div>
              </div>
            </div>

            ${
              !isStanding
                ? `<span class="px-2.5 py-1 rounded-full text-[10px] font-extrabold uppercase tracking-wider bg-red-500/20 text-red-300 border border-red-500/40 shrink-0">
                     💀 KNOCKED OUT
                   </span>`
                : `<span class="px-2.5 py-1 rounded-full text-[10px] font-extrabold uppercase tracking-wider bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shrink-0">
                     🟢 STANDING
                   </span>`
            }
          </div>

          <!-- Deflection & Shield Status Strip -->
          <div class="flex flex-wrap items-center gap-1.5 mb-3 text-[10px] font-bold">
            <span class="px-2 py-0.5 rounded-lg ${
              deflectActive
                ? 'bg-purple-500/25 text-purple-200 border border-purple-400/50'
                : deflectBroken
                ? 'bg-red-500/20 text-red-300'
                : store.deflection.qualifiedForDay
                ? 'bg-purple-500/10 text-purple-300 border border-purple-500/20'
                : 'bg-arena-elevated text-zinc-400'
            }">
              ${
                deflectActive
                  ? '🛡️ DEFLECTION ACTIVE (100 DMG)'
                  : deflectBroken
                  ? '💥 DEFLECTION BROKEN'
                  : store.deflection.qualifiedForDay
                  ? '🛡️ Deflection Qualified (Needs ≥1,350 at round start)'
                  : `Deflection: ${store.deflection.survivedAttacksInFirst120}/2 survivals`
              }
            </span>
            <span class="px-2 py-0.5 rounded-lg ${shieldBadgeClass}">
              Shield: ${shieldStatusLabel}
            </span>
          </div>

          ${sheetRow ? `<div class="text-[11px] text-cyan-300 border border-cyan-500/30 rounded-lg p-2 mb-3">
            <strong>Google Sheet · ${escapeHtml(sheetReport.dateKey)}</strong><br>
            VL ${sheetRow.vl} · BTS ${sheetRow.bts} · HINT ${sheetRow.hsi} · ACC $${(sheetRow.accCents/100).toFixed(2)}<br>
            Sheet earned: ${Number(sheetRow.sheetEarnedPoints || 0).toLocaleString()} pts<br>
            ${sheetReport.status === 'PENDING_CUTOFF' ? 'Imported · combat points follow sales cutoffs' : 'Saved to reporting event/week · combat results unchanged'}
          </div>` : ''}
          <!-- Primary Balances Box -->
          <div class="grid grid-cols-4 gap-1.5 p-2.5 rounded-xl bg-arena-bg/90 border border-arena-border mb-3 text-center">
            <div class="border-r border-arena-border pr-1">
              <div class="text-[9px] font-bold uppercase text-zinc-400">Available</div>
              <div class="font-display text-2xl leading-tight ${store.availableBp >= 35000 ? 'text-amber-400' : 'text-red-400'}">
                ${formatBpDisplay(store.availableBp)}
              </div>
            </div>
            <div class="border-r border-arena-border pr-1">
              <div class="text-[9px] font-bold uppercase text-zinc-400">Total Earned</div>
              <div class="font-mono text-xs font-extrabold text-emerald-400 mt-1">
                ${formatBpDisplay(store.totalEarnedBp)}
              </div>
            </div>
            <div class="border-r border-arena-border pr-1">
              <div class="text-[9px] font-bold uppercase text-zinc-400">Pending</div>
              <div class="font-mono text-xs font-extrabold text-purple-300 mt-1">
                +${formatBpDisplay(store.pendingBp)}
              </div>
            </div>
            <div>
              <div class="text-[9px] font-bold uppercase text-zinc-400">Spent / Dmg</div>
              <div class="font-mono text-[11px] font-extrabold text-zinc-300 mt-1">
                <span class="text-red-300">-${formatBpDisplay(store.attackSpentBp + store.revivalSpentBp + store.shieldSpentBp)}</span>
                <span class="text-zinc-500">/</span>
                <span class="text-orange-400">-${formatBpDisplay(store.incomingDamageBp)}</span>
              </div>
            </div>
          </div>

          <!-- Sales Quantities Breakdown -->
          <div class="grid grid-cols-5 gap-1 text-[10px] text-center">
            <div class="bg-arena-elevated/70 border border-white/5 rounded-lg p-1.5">
              <div class="text-zinc-400">VL (200)</div>
              <div class="font-mono font-bold text-white">${store.quantities.totalVl}</div>
            </div>
            <div class="bg-arena-elevated/70 border border-white/5 rounded-lg p-1.5">
              <div class="text-zinc-400">BTS (200)</div>
              <div class="font-mono font-bold text-cyan-300">${store.quantities.bts}</div>
            </div>
            <div class="bg-arena-elevated/70 border border-white/5 rounded-lg p-1.5">
              <div class="text-zinc-400">HINT (600)</div>
              <div class="font-mono font-bold text-purple-300">${store.quantities.hsi}</div>
            </div>
            <div class="bg-arena-elevated/70 border border-white/5 rounded-lg p-1.5">
              <div class="text-zinc-400">Acc (2/$1)</div>
              <div class="font-mono font-bold text-pink-300">${formatCentsDisplay(store.quantities.accCents)}</div>
            </div>
            <div class="bg-emerald-500/15 border border-emerald-400/40 rounded-lg p-1.5" title="Automatic +300 bonus points for every 300 points earned from sales">
              <div class="text-emerald-300">+300 Bonus</div>
              <div class="font-mono font-bold text-emerald-200">+${formatBpDisplay(store.salesMilestoneBonusBp || 0)}</div>
            </div>
          </div>
        </div>

        ${
          isStanding && (!clientSession.storeId || clientSession.storeId !== store.id)
            ? `<div class="pt-3 mt-3 border-t border-arena-border/60">
                 <button type="button" onclick="selectTargetFromCard('${store.id}')"
                         class="w-full py-1.5 px-3 rounded-xl bg-arena-elevated hover:bg-magenta/25 border border-arena-border hover:border-magenta/50 text-zinc-200 text-[11px] font-bold uppercase tracking-wider transition">
                   🎯 Target ${escapeHtml(store.shortName)} in Combat Deck
                 </button>
               </div>`
            : ''
        }
      </div>
    `;
  }).join('');
}

window.selectTargetFromCard = function (targetId) {
  const sel = document.getElementById('select-store-battle-target');
  if (sel) {
    sel.value = targetId;
    updateAttackModeOptions();
    document.getElementById('store-battle-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
};

function renderWeeklyStandingsView() {
  const wk = serverState.weeklyStandings;
  if (!wk) return;

  document.getElementById('weekly-counted-days-badge').textContent = `${wk.countedDaysCount} Counted Event Day${wk.countedDaysCount === 1 ? '' : 's'} Held`;

  const tbody = document.getElementById('weekly-standings-tbody');
  tbody.innerHTML = (wk.standings || []).map((row, idx) => {
    return `
      <tr class="hover:bg-arena-elevated/40 transition">
        <td class="py-3 px-4 font-display text-2xl text-zinc-300">#${idx + 1}</td>
        <td class="py-3 px-4 font-semibold text-white">
          <span class="mr-1.5">${row.emoji}</span>${escapeHtml(row.name)}
          ${row.isAdminSelectedWinner ? '<span class="ml-1.5 px-2 py-0.5 rounded bg-amber-400 text-black text-[10px] font-extrabold">🏆 ADMIN TIE WINNER</span>' : ''}
          ${row.isSharedResultWinner ? '<span class="ml-1.5 px-2 py-0.5 rounded bg-purple-400 text-black text-[10px] font-extrabold">🤝 SHARED RESULT</span>' : ''}
        </td>
        <td class="py-3 px-3 text-right font-mono font-extrabold text-amber-300">${row.cumulativeEarnedPoints.toLocaleString()}</td>
        <td class="py-3 px-3 text-right font-mono font-bold text-cyan-300">${row.averageDailyEarnedPoints.toLocaleString()}</td>
        <td class="py-3 px-3 text-right font-mono text-emerald-300">${row.cumulativeSalesEarnedPoints.toLocaleString()}</td>
        <td class="py-3 px-3 text-right font-mono text-zinc-300">${formatBpDisplay(row.cumulativeAdminBonusBp)}</td>
        <td class="py-3 px-3 text-center font-mono text-zinc-400">${row.countedDaysHeld}</td>
        <td class="py-3 px-3 text-center font-mono font-bold text-emerald-400">${row.qualifierCount}</td>
      </tr>
    `;
  }).join('');

  // Render 7-day weekly matrix
  const daysGrid = document.getElementById('weekly-days-grid');
  const dateKeys = serverState.currentWeek?.eventDateKeys || [];
  const qualifiersByDate = serverState.currentWeek?.dailyQualifiersByDate || {};
  const countedDays = serverState.currentWeek?.countedDaysHeld || [];

  daysGrid.innerHTML = dateKeys.map(dKey => {
    const held = countedDays.includes(dKey);
    const qList = qualifiersByDate[dKey] || [];
    const isToday = serverState.currentEvent?.dateKey === dKey;
    return `
      <div class="p-3 rounded-xl border ${isToday ? 'border-magenta bg-magenta/10' : 'border-arena-border bg-arena-elevated/50'}">
        <div class="flex items-center justify-between text-[10px] font-bold uppercase text-zinc-400">
          <span>${dKey}</span>
          ${held ? '<span class="text-emerald-400">HELD</span>' : '<span class="text-zinc-500">SCHED</span>'}
        </div>
        <div class="mt-1.5 text-xs font-bold text-white">
          Qualifiers: <span class="text-emerald-400">${qList.length}</span>
        </div>
        <div class="mt-1 text-[10px] text-zinc-400 truncate">
          ${qList.length > 0 ? qList.join(', ') : '—'}
        </div>
      </div>
    `;
  }).join('');
}

function renderFullLedgerAndScheduleView(storesList, evt, sched, nowMs) {
  const tbody = document.getElementById('ledger-table-body');
  tbody.innerHTML = storesList.map(s => {
    return `
      <tr class="hover:bg-arena-elevated/40 transition ${s.status !== 'STANDING' ? 'opacity-65 bg-red-950/10' : ''}">
        <td class="py-2.5 px-3 font-semibold text-white whitespace-nowrap">${s.emoji} ${escapeHtml(s.name)}</td>
        <td class="py-2.5 px-2 text-center">
          <span class="px-2 py-0.5 rounded-full text-[9px] font-extrabold ${s.status === 'STANDING' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}">
            ${s.status}
          </span>
        </td>
        <td class="py-2.5 px-2 text-right font-mono text-zinc-300">${formatBpDisplay(s.carriedOpeningBalanceBp)}</td>
        <td class="py-2.5 px-2 text-right font-mono text-emerald-300">${formatBpDisplay(s.salesEarnedBp)}</td>
        <td class="py-2.5 px-2 text-right font-mono text-zinc-300">${formatBpDisplay(s.adminBonusBp)}</td>
        <td class="py-2.5 px-2 text-right font-mono font-bold text-amber-300">${formatBpDisplay(s.totalEarnedBp)}</td>
        <td class="py-2.5 px-2 text-right font-mono text-purple-300">+${formatBpDisplay(s.pendingBp)}</td>
        <td class="py-2.5 px-2 text-right font-mono text-red-300">-${formatBpDisplay(s.attackSpentBp)}</td>
        <td class="py-2.5 px-2 text-right font-mono text-teal-300">-${formatBpDisplay(s.revivalSpentBp)}</td>
        <td class="py-2.5 px-2 text-right font-mono text-cyan-300">-${formatBpDisplay(s.shieldSpentBp)}</td>
        <td class="py-2.5 px-2 text-right font-mono text-orange-400">-${formatBpDisplay(s.incomingDamageBp)}</td>
        <td class="py-2.5 px-3 text-right font-mono font-extrabold text-sm text-white">${formatBpDisplay(s.availableBp)}</td>
      </tr>
    `;
  }).join('');

  // Rounds schedule list
  const roundsListEl = document.getElementById('schedule-rounds-list');
  if (sched && Array.isArray(sched.rounds)) {
    roundsListEl.innerHTML = sched.rounds.map(r => {
      const rState = evt.roundStates?.[r.roundId];
      const status = rState?.status || (nowMs >= r.endMs ? 'PAST' : 'UPCOMING');
      return `
        <div class="flex items-center justify-between px-3 py-1.5 rounded-lg bg-arena-elevated/60 border border-white/5">
          <div>
            <span class="font-mono font-bold text-white">${r.label} ET</span>
            <span class="text-[10px] text-zinc-400 ml-1.5">(Cutoff: ${formatEtTime(r.cutoffMs)})</span>
          </div>
          <span class="text-[10px] font-extrabold px-2 py-0.5 rounded ${
            status === 'OPEN'
              ? 'bg-emerald-500/20 text-emerald-300 animate-pulse'
              : status === 'CLOSED' || status === 'PAST'
              ? 'bg-zinc-800 text-zinc-500'
              : 'bg-magenta/20 text-magenta-light'
          }">${status}</span>
        </div>
      `;
    }).join('');
  }

  // Elimination checkpoints list
  const chkListEl = document.getElementById('schedule-checkpoints-list');
  if (sched && Array.isArray(sched.eliminationCheckpoints)) {
    chkListEl.innerHTML = sched.eliminationCheckpoints.map(c => {
      const proc = evt.processedCheckpoints?.[c.checkpointId];
      return `
        <div class="flex items-center justify-between px-3 py-1.5 rounded-lg bg-arena-elevated/60 border border-white/5">
          <div>
            <span class="font-mono font-bold text-white">${c.label} ET</span>
            <span class="text-[10px] text-zinc-400 ml-1.5">${c.isPowerPhase ? '(Power Phase - Permanent)' : '(Pre-Power Phase - Revivable)'}</span>
          </div>
          <span class="text-[10px] font-extrabold px-2 py-0.5 rounded ${
            proc
              ? 'bg-red-500/20 text-red-300'
              : 'bg-zinc-800 text-zinc-300'
          }">${proc ? (proc.eliminatedStoreId ? `KO: ${proc.eliminatedStoreId}` : proc.status) : 'SCHEDULED'}</span>
        </div>
      `;
    }).join('');
  }
}

function renderStoreCombatDeck(storesList, myStore, evt, sched, nowMs) {
  const statusPill = document.getElementById('store-battle-status-pill');
  const displayEl = document.getElementById('battle-my-store-display');
  const ptsEl = document.getElementById('battle-my-store-pts');
  const myStoreSelect = document.getElementById('select-combat-my-store');
  const allowanceBadge = document.getElementById('store-allowance-badge');
  const targetSelect = document.getElementById('select-store-battle-target');
  const attackBtn = document.getElementById('btn-store-submit-attack');
  const reviveBtn = document.getElementById('btn-store-submit-revive');
  const shieldBtn = document.getElementById('btn-store-buy-shield');
  const reviveCostLabel = document.getElementById('label-revive-cost-btn');

  if (myStoreSelect) {
    myStoreSelect.innerHTML = storesList
      .map(s => `<option value="${s.id}">${s.emoji} ${escapeHtml(s.name)} (${formatBpDisplay(s.availableBp)} avail pts • ${s.status})</option>`)
      .join('');
    if (myStore) {
      myStoreSelect.value = myStore.id;
    }
  }

  const activeRound = evt.activeRoundId ? evt.roundStates?.[evt.activeRoundId] : null;
  const isRoundOpen = Boolean(activeRound && activeRound.status === 'OPEN' && nowMs >= activeRound.startMs && nowMs < activeRound.endMs);
  const isPowerPhase = evt.phase === 'POWER_PHASE' || (sched && nowMs >= sched.powerPhaseStartMs);

  if (isRoundOpen) {
    statusPill.className = 'text-[10px] font-extrabold uppercase tracking-widest px-2.5 py-1 rounded-full bg-emerald-500/25 text-emerald-300 border border-emerald-400/50 animate-pulse';
    statusPill.textContent = `🔥 ROUND OPEN (${formatCountdown(activeRound.endMs - nowMs)})`;
  } else {
    statusPill.className = 'text-[10px] font-extrabold uppercase tracking-widest px-2.5 py-1 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700';
    statusPill.textContent = '⏳ BETWEEN ROUNDS';
  }

  if (myStore) {
    displayEl.textContent = `${myStore.emoji} ${myStore.name}`;
    ptsEl.textContent = `${formatBpDisplay(myStore.availableBp)} Avail Pts • ${myStore.status}`;
  } else {
    displayEl.textContent = 'Select Your Store';
    ptsEl.textContent = 'Choose store below';
  }

  const attacksUsed = isRoundOpen && myStore ? Number(activeRound.attacksByStore?.[myStore.id] || 0) : 0;
  allowanceBadge.textContent = `${attacksUsed} / 2 Used`;

  // Populate eligible standing targets (excluding myStore and shielded stores)
  const prevTarget = targetSelect.value;
  const targets = storesList.filter(s => s.status === 'STANDING' && (!myStore || s.id !== myStore.id));
  targetSelect.innerHTML = targets.length
    ? targets.map(t => {
        const isShielded = isRoundOpen && t.shield?.protectedUntilMs && nowMs < t.shield.protectedUntilMs;
        const isDeflecting = isRoundOpen && activeRound.deflectionSnapshot?.[t.id] && t.deflection.activeForRoundId === activeRound.roundId && t.deflection.brokenInRoundId !== activeRound.roundId;
        return `<option value="${t.id}" ${isShielded ? 'disabled' : ''}>🎯 ${escapeHtml(t.name)} (${formatBpDisplay(t.availableBp)} pts)${isShielded ? ' [🛡️ SHIELDED]' : isDeflecting ? ' [🛡️ DEFLECTING]' : ''}</option>`;
      }).join('')
    : '<option value="">No standing targets available</option>';

  if (prevTarget && targets.some(t => t.id === prevTarget)) {
    targetSelect.value = prevTarget;
  }

  updateAttackModeOptions();

  // Enable/disable buttons
  const canAttack = Boolean(
    isRoundOpen &&
      myStore &&
      myStore.status === 'STANDING' &&
      attacksUsed < 2 &&
      myStore.availableBp >= 20000
  );
  attackBtn.disabled = !canAttack;

  const reviveCostPts = isRoundOpen ? 400 : 200;
  reviveCostLabel.textContent = reviveCostPts;
  const canRevive = Boolean(
    evt.status === 'ACTIVE' &&
      !isPowerPhase &&
      myStore &&
      myStore.status === 'KNOCKED_OUT' &&
      myStore.availableBp >= reviveCostPts * 100
  );
  reviveBtn.disabled = !canRevive;

  const canBuyShield = Boolean(
    evt.status === 'ACTIVE' &&
      isPowerPhase &&
      !isRoundOpen &&
      myStore &&
      myStore.status === 'STANDING' &&
      myStore.availableBp >= 60000 &&
      !myStore.shield?.queuedForRoundId
  );
  shieldBtn.disabled = !canBuyShield;
}

function updateAttackModeOptions() {
  if (!serverState || !serverState.currentEvent) return;
  const evt = serverState.currentEvent;
  const activeRound = evt.activeRoundId ? evt.roundStates?.[evt.activeRoundId] : null;
  const targetId = document.getElementById('select-store-battle-target')?.value;
  const modeSelect = document.getElementById('select-store-attack-mode');
  if (!modeSelect) return;

  const myStoreId = clientSession.storeId;
  const canUseBreaker = Boolean(
    activeRound &&
      myStoreId &&
      targetId &&
      activeRound.deflectedHits?.[myStoreId]?.[targetId] &&
      serverState.stores?.[targetId]?.deflection?.activeForRoundId === activeRound.roundId
  );

  const breakerOpt = modeSelect.querySelector('option[value="BREAKER"]');
  if (breakerOpt) {
    breakerOpt.disabled = !canUseBreaker;
    breakerOpt.textContent = canUseBreaker
      ? '💥 Deflection Breaker UNLOCKED! (400 pts → 500 dmg & Breaks Deflection)'
      : '💥 Deflection Breaker (Requires landing 1st deflected hit on this target in this round)';
  }
  if (!canUseBreaker && modeSelect.value === 'BREAKER') {
    modeSelect.value = 'NORMAL';
  }
}

function renderAdminPanel(storesList, evt, sched, nowMs) {
  // Populate store selects in Admin tabs
  ['select-line-store', 'select-audit-store', 'select-weekly-winner-store'].forEach(selId => {
    const sel = document.getElementById(selId);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = storesList.map(s => `<option value="${s.id}">${s.emoji} ${escapeHtml(s.name)} (${formatBpDisplay(s.availableBp)} avail)</option>`).join('');
    if (prev && storesList.some(s => s.id === prev)) sel.value = prev;
  });

  // Event lifecycle timestamps
  const tsInfo = document.getElementById('admin-event-timestamps-info');
  if (tsInfo) {
    tsInfo.innerHTML = `
      <div>Date: <strong>${evt.dateKey} (${evt.weekdayShort})</strong> • Status: <strong>${evt.status}</strong></div>
      <div>Scheduled: ${formatEtTime(evt.scheduledStartMs)} – ${formatEtTime(evt.scheduledCloseMs)} ET</div>
      <div>Actual Start: ${evt.actualStartMs ? formatEtTime(evt.actualStartMs) + ' ET' : 'Not started'}</div>
      <div>Actual Close: ${evt.actualCloseMs ? formatEtTime(evt.actualCloseMs) + ' ET' : '—'}</div>
    `;
  }

  // Enabled weekdays toggles
  const daysBox = document.getElementById('admin-enabled-days-toggles');
  if (daysBox && serverState.enabledWeekdays) {
    daysBox.innerHTML = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => {
      const on = Boolean(serverState.enabledWeekdays[day]);
      return `
        <button type="button" onclick="toggleEnabledWeekday('${day}', ${!on})"
                class="py-1.5 rounded-lg text-[10px] font-extrabold border transition ${
                  on ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300' : 'bg-zinc-900 border-zinc-700 text-zinc-500'
                }">
          ${day}
        </button>
      `;
    }).join('');
  }

  // Elimination Tie Resolution Box
  const tieContent = document.getElementById('admin-elim-tie-content');
  if (tieContent) {
    if (evt.pendingEliminationTie) {
      const tie = evt.pendingEliminationTie;
      tieContent.innerHTML = `
        <div class="mb-2 text-amber-200">Checkpoint <strong>${tie.checkpointLabel} ET</strong> paused. Select which tied candidate store is eliminated:</div>
        <div class="flex flex-wrap gap-1.5">
          ${tie.candidateSnapshots.map(c => `
            <button type="button" onclick="adminResolveCheckpointTie('${c.storeId}')"
                    class="px-2.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white font-extrabold text-[10px]">
              Eliminate ${escapeHtml(c.name)} (${c.availablePoints} avail)
            </button>
          `).join('')}
        </div>
      `;
    } else {
      tieContent.textContent = 'No unresolved elimination checkpoint ties.';
    }
  }

  // Reconciliation issues queue
  const recList = document.getElementById('admin-reconciliation-list');
  if (recList) {
    const unresolved = (serverState.reconciliationIssues || []).filter(i => !i.resolved);
    if (unresolved.length === 0) {
      recList.innerHTML = '<div class="text-zinc-500">All sheet imports & sales reconciled cleanly.</div>';
    } else {
      recList.innerHTML = unresolved.map(iss => `
        <div class="p-2 rounded-lg bg-arena-elevated border border-pink-500/30 space-y-1">
          <div class="font-bold text-pink-300">${escapeHtml(iss.type)} — ${escapeHtml(iss.storeId)}</div>
          <div class="text-[10px] text-zinc-300">${escapeHtml(iss.description)}</div>
          <div class="flex gap-1.5 pt-1">
            <button type="button" onclick="adminResolveIssue('${iss.issueId}', '${iss.type === 'LATE_CROSS_BOUNDARY_SALE' ? 'APPLY_CURRENT' : 'APPLY'}')"
                    class="px-2 py-1 rounded bg-emerald-600 text-white text-[10px] font-bold">
              Approve / Apply
            </button>
            <button type="button" onclick="adminResolveIssue('${iss.issueId}', 'DISMISS')"
                    class="px-2 py-1 rounded bg-zinc-700 text-zinc-200 text-[10px] font-bold">
              Dismiss
            </button>
          </div>
        </div>
      `).join('');
    }
  }

  // Store Access Codes Provisioning inputs
  const codesBox = document.getElementById('admin-store-codes-inputs');
  if (codesBox && !codesBox.hasChildNodes()) {
    codesBox.innerHTML = storesList.map(s => {
      const isConfigured = serverState.authStatus?.configuredStoreAuth?.[s.id];
      return `
        <div class="flex items-center justify-between gap-2">
          <span class="text-[11px] font-semibold text-zinc-200 w-40 truncate">${s.emoji} ${escapeHtml(s.name)}</span>
          <input type="text" data-store-code-input="${s.id}" placeholder="${isConfigured ? 'Configured (enter to rotate)' : 'Set access code...'}"
                 class="flex-1 bg-arena-bg border border-arena-border rounded-lg px-2.5 py-1 text-xs font-mono text-white" />
        </div>
      `;
    }).join('');
  }
}

function renderActivityFeed(storesMap) {
  const feedEl = document.getElementById('combat-feed');
  const feedCount = document.getElementById('feed-count');

  const combatItems = (serverState.combatLog || []).map(c => ({ ...c, feedKind: 'COMBAT' }));
  const salesItems = (serverState.salesLog || []).slice(-30).map(s => ({ ...s, feedKind: 'SALE', timestampMs: s.ingestedAtMs }));
  const combined = [...combatItems, ...salesItems].sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));

  feedCount.textContent = combined.length;

  if (combined.length === 0) {
    feedEl.innerHTML = `
      <div class="text-center py-8 px-4 text-zinc-500 text-xs">
        <div class="text-3xl mb-2">🥊🔥</div>
        <div class="font-bold text-zinc-300">KNOCKOUT BLITZ ARENA READY</div>
        <p class="mt-1">Attacks, Deflections, Breakers, Shields, Revivals, and Sales Cutoffs will stream live here.</p>
      </div>
    `;
    return;
  }

  feedEl.innerHTML = combined.slice(0, 50).map(item => {
    const timeStr = formatEtTime(item.timestampMs);
    if (item.feedKind === 'SALE') {
      const st = storesMap[item.storeId] || { name: item.storeId };
      return `
        <div class="p-2.5 rounded-xl bg-arena-elevated/80 border border-white/10 text-xs flex items-center justify-between">
          <div>
            <span class="font-bold text-amber-300">+${item.points} PTS</span>
            <span class="text-zinc-300 ml-1">${escapeHtml(st.name)} (${escapeHtml(item.category)})</span>
            <span class="text-[10px] ml-1 px-1.5 py-0.5 rounded ${item.status === 'RELEASED' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-purple-500/20 text-purple-300'}">${item.status}</span>
          </div>
          <span class="text-[10px] font-mono text-zinc-500">${timeStr}</span>
        </div>
      `;
    }

    if (item.type === 'ATTACK') {
      const atk = storesMap[item.attackerId] || { name: item.attackerId };
      const tgt = storesMap[item.targetId] || { name: item.targetId };
      return `
        <div class="p-3 rounded-xl ${item.resultingKnockout ? 'bg-red-500/15 border-red-500/40' : 'bg-magenta/10 border-magenta/30'} border text-xs">
          <div class="flex items-center justify-between">
            <span class="font-extrabold ${item.resultingKnockout ? 'text-red-400' : 'text-magenta-light'}">
              ${item.resultingKnockout ? '🥊 KNOCKOUT!' : `⚔️ ${item.attackType}`}
            </span>
            <span class="text-[10px] font-mono text-zinc-400">${timeStr} ET</span>
          </div>
          <div class="mt-1 text-zinc-200">
            <strong>${escapeHtml(atk.name)}</strong> (-${item.costPoints}) hit <strong>${escapeHtml(tgt.name)}</strong> for <strong>-${item.effectiveDamagePoints} dmg</strong> (${item.targetBalanceBefore} → ${item.targetBalanceAfter} pts)
          </div>
        </div>
      `;
    }

    if (item.type === 'REVIVE') {
      const st = storesMap[item.storeId] || { name: item.storeId };
      return `
        <div class="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs">
          <div class="flex justify-between">
            <span class="font-extrabold text-emerald-400">⚡ SELF-REVIVED (-${item.costPoints} pts)</span>
            <span class="text-[10px] font-mono text-zinc-400">${timeStr} ET</span>
          </div>
          <div class="mt-0.5 text-zinc-200"><strong>${escapeHtml(st.name)}</strong> restored to Standing (${item.balanceAfter} pts left).</div>
        </div>
      `;
    }

    if (item.type === 'SHIELD_PURCHASE') {
      const st = storesMap[item.storeId] || { name: item.storeId };
      return `
        <div class="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-xs">
          <div class="flex justify-between">
            <span class="font-extrabold text-cyan-300">🛡️ POWER SHIELD QUEUED (-600 pts)</span>
            <span class="text-[10px] font-mono text-zinc-400">${timeStr} ET</span>
          </div>
          <div class="mt-0.5 text-zinc-200"><strong>${escapeHtml(st.name)}</strong> queued a 3-min Shield for ${escapeHtml(item.queuedForRoundLabel)}.</div>
        </div>
      `;
    }

    const tgt = storesMap[item.targetId] || { name: item.targetId };
    return `
      <div class="p-2.5 rounded-xl bg-red-950/40 border border-red-500/40 text-xs">
        <div class="flex justify-between">
          <span class="font-extrabold text-red-400">💀 ${escapeHtml(item.type)}</span>
          <span class="text-[10px] font-mono text-zinc-400">${timeStr} ET</span>
        </div>
        <div class="mt-0.5 text-zinc-200"><strong>${escapeHtml(tgt.name)}</strong> eliminated (${escapeHtml(item.checkpointLabel || item.reason || '')}).</div>
      </div>
    `;
  }).join('');
}

// Global Admin Helper Actions
window.adminQuickSale = async function (category, qty) {
  const storeId = document.getElementById('select-line-store')?.value;
  if (!storeId) return;
  try {
    await postServerAction({
      action: 'admin_log_sale',
      storeId,
      category,
      qty
    });
  } catch (err) {
    alert(err.message);
  }
};

window.toggleEnabledWeekday = async function (day, enabled) {
  try {
    await postServerAction({
      action: 'admin_set_enabled_days',
      enabledWeekdays: { [day]: enabled }
    });
  } catch (err) {
    alert(err.message);
  }
};

window.adminResolveCheckpointTie = async function (eliminatedStoreId) {
  const note = prompt(`Enter admin audit note for eliminating ${eliminatedStoreId}:`) || 'Resolved checkpoint tie';
  try {
    await postServerAction({
      action: 'admin_resolve_elimination_tie',
      eliminatedStoreId,
      note
    });
  } catch (err) {
    alert(err.message);
  }
};

window.adminResolveIssue = async function (issueId, resolution) {
  try {
    await postServerAction({
      action: 'admin_resolve_reconciliation_issue',
      issueId,
      resolution
    });
  } catch (err) {
    alert(err.message);
  }
};

// Shareable PNG Status Report Generator (Section 20)
function exportShareablePngReport() {
  if (!serverState) return;
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 760;
  const ctx = canvas.getContext('2d');

  // Background
  const grad = ctx.createLinearGradient(0, 0, 1200, 760);
  grad.addColorStop(0, '#09090E');
  grad.addColorStop(1, '#180B16');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1200, 760);

  // Header
  ctx.fillStyle = '#E20074';
  ctx.fillRect(0, 0, 1200, 8);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 42px sans-serif';
  ctx.fillText('KNOCKOUT BLITZ — PHOENIX DISTRICT STATUS REPORT', 40, 62);

  ctx.fillStyle = '#FBBF24';
  ctx.font = 'bold 18px monospace';
  const evt = serverState.currentEvent;
  ctx.fillText(
    `Date: ${evt?.dateKey || ''} (${evt?.weekdayShort || ''}) | Phase: ${evt?.phase || ''} | Generated: ${formatEtClock(getServerNowMs())} ET`,
    40,
    95
  );

  // Table Headers
  const headers = ['RANK', 'STORE', 'STATUS', 'AVAILABLE PTS', 'EARNED PTS', 'PENDING', 'SPENT / DMG', 'WEEKLY AVG'];
  const colX = [40, 110, 410, 560, 720, 860, 980, 1100];
  ctx.fillStyle = '#9CA3AF';
  ctx.font = 'bold 14px monospace';
  headers.forEach((h, i) => ctx.fillText(h, colX[i], 140));

  ctx.strokeStyle = '#252738';
  ctx.beginPath();
  ctx.moveTo(40, 152);
  ctx.lineTo(1160, 152);
  ctx.stroke();

  const storesList = ROSTER_ORDER.map(id => serverState.stores?.[id]).filter(Boolean);
  storesList.sort((a, b) => b.availableBp - a.availableBp || b.totalEarnedBp - a.totalEarnedBp);
  const wkMap = {};
  (serverState.weeklyStandings?.standings || []).forEach(w => {
    wkMap[w.storeId] = w;
  });

  storesList.forEach((s, idx) => {
    const y = 195 + idx * 56;
    ctx.fillStyle = s.status === 'STANDING' ? 'rgba(18, 19, 28, 0.9)' : 'rgba(45, 14, 22, 0.7)';
    ctx.fillRect(35, y - 32, 1130, 46);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 20px monospace';
    ctx.fillText(`#${idx + 1}`, colX[0], y);
    ctx.fillText(s.name, colX[1], y);

    ctx.fillStyle = s.status === 'STANDING' ? '#34D399' : '#F87171';
    ctx.font = 'bold 16px monospace';
    ctx.fillText(s.status, colX[2], y);

    ctx.fillStyle = '#FBBF24';
    ctx.font = 'bold 22px monospace';
    ctx.fillText(formatBpDisplay(s.availableBp), colX[3], y);

    ctx.fillStyle = '#34D399';
    ctx.font = 'bold 18px monospace';
    ctx.fillText(formatBpDisplay(s.totalEarnedBp), colX[4], y);

    ctx.fillStyle = '#C084FC';
    ctx.fillText(`+${formatBpDisplay(s.pendingBp)}`, colX[5], y);

    ctx.fillStyle = '#FB923C';
    const spent = s.attackSpentBp + s.revivalSpentBp + s.shieldSpentBp;
    ctx.fillText(`-${formatBpDisplay(spent)} / -${formatBpDisplay(s.incomingDamageBp)}`, colX[6], y);

    ctx.fillStyle = '#38BDF8';
    ctx.fillText(String(wkMap[s.id]?.averageDailyEarnedPoints || 0), colX[7], y);
  });

  const link = document.createElement('a');
  link.download = `knockout-blitz-report-${evt?.dateKey || 'live'}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

// Wire DOM Events
document.addEventListener('DOMContentLoaded', () => {
  loadClientSession();
  if (serverState) renderAll();
  fetchAuthoritativeState();

  setInterval(updateTelemetryTick, 1000);
  setInterval(fetchAuthoritativeState, 4000);

  // View Switcher Tabs
  document.querySelectorAll('.view-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const v = btn.getAttribute('data-view');
      clientSession.activeView = v;
      document.getElementById('view-section-arena').classList.toggle('hidden', v !== 'arena');
      document.getElementById('view-section-weekly').classList.toggle('hidden', v !== 'weekly');
      document.getElementById('view-section-ledger').classList.toggle('hidden', v !== 'ledger');
      document.getElementById('arena-filters-box').classList.toggle('hidden', v !== 'arena');
    });
  });

  // Admin Sub-Tabs
  document.querySelectorAll('.admin-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.admin-tab').forEach(b => {
        b.classList.remove('active-lines');
        b.classList.add('text-zinc-400');
      });
      btn.classList.add('active-lines');
      btn.classList.remove('text-zinc-400');
      const tab = btn.getAttribute('data-admintab');
      ['sales', 'lifecycle', 'audit', 'auth'].forEach(t => {
        document.getElementById(`admintab-${t}`)?.classList.toggle('hidden', t !== tab);
      });
    });
  });

  // Filter & Sort
  document.getElementById('filter-select')?.addEventListener('change', e => {
    clientSession.filter = e.target.value;
    renderAll();
  });
  document.getElementById('sort-select')?.addEventListener('change', e => {
    clientSession.sortBy = e.target.value;
    renderAll();
  });
  document.getElementById('select-store-battle-target')?.addEventListener('change', updateAttackModeOptions);

  // Direct Store Selector in Combat Deck & Modal (No Store Login Required)
  const setPlayingStore = (storeId) => {
    if (!storeId) return;
    clientSession.storeId = storeId;
    clientSession.storeToken = '';
    try {
      localStorage.setItem(STORE_AUTH_KEY, JSON.stringify({ storeId, storeToken: '' }));
      sessionStorage.setItem(STORE_AUTH_KEY, JSON.stringify({ storeId, storeToken: '' }));
    } catch (e) {}
    renderAll();
  };

  document.getElementById('select-combat-my-store')?.addEventListener('change', e => {
    setPlayingStore(e.target.value);
  });

  const openStoreModal = () => {
    const modal = document.getElementById('modal-pick-store');
    const sel = document.getElementById('select-auth-store-id');
    if (sel && serverState?.stores) {
      sel.innerHTML = ROSTER_ORDER.map(id => {
        const s = serverState.stores[id];
        return s ? `<option value="${s.id}">${s.emoji} ${escapeHtml(s.name)}</option>` : '';
      }).join('');
      if (clientSession.storeId) sel.value = clientSession.storeId;
    }
    document.getElementById('store-auth-error')?.classList.add('hidden');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  };

  document.getElementById('btn-change-my-store')?.addEventListener('click', openStoreModal);
  document.getElementById('btn-close-pick-store')?.addEventListener('click', () => {
    const m = document.getElementById('modal-pick-store');
    m.classList.add('hidden');
    m.classList.remove('flex');
  });

  document.getElementById('form-store-auth')?.addEventListener('submit', e => {
    e.preventDefault();
    const storeId = document.getElementById('select-auth-store-id').value;
    setPlayingStore(storeId);
    const m = document.getElementById('modal-pick-store');
    m.classList.add('hidden');
    m.classList.remove('flex');
  });

  // Store Combat Actions (Attack, Revive, Shield)
  document.getElementById('btn-store-submit-attack')?.addEventListener('click', async () => {
    const targetId = document.getElementById('select-store-battle-target').value;
    const attackMode = document.getElementById('select-store-attack-mode').value;
    const noteInput = document.getElementById('input-store-battle-note');
    try {
      await postServerAction({
        action: 'store_attack',
        storeId: clientSession.storeId,
        targetId,
        attackMode,
        idempotencyKey: makeIdempotencyKey('atk'),
        note: noteInput.value.trim()
      });
      noteInput.value = '';
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('btn-store-submit-revive')?.addEventListener('click', async () => {
    try {
      await postServerAction({
        action: 'store_revive',
        storeId: clientSession.storeId,
        idempotencyKey: makeIdempotencyKey('rev')
      });
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('btn-store-buy-shield')?.addEventListener('click', async () => {
    try {
      await postServerAction({
        action: 'store_purchase_shield',
        storeId: clientSession.storeId,
        idempotencyKey: makeIdempotencyKey('shd')
      });
    } catch (err) {
      alert(err.message);
    }
  });

  // Admin Login / Logout
  document.getElementById('btn-admin-toggle')?.addEventListener('click', () => {
    if (clientSession.isAdmin) {
      clientSession.isAdmin = false;
      clientSession.adminToken = '';
      clientSession.adminPin = '';
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      renderAll();
    } else {
      const m = document.getElementById('modal-admin-login');
      document.getElementById('admin-pin-error').classList.add('hidden');
      document.getElementById('input-admin-pin').value = '';
      m.classList.remove('hidden');
      m.classList.add('flex');
    }
  });

  document.getElementById('btn-close-admin-login')?.addEventListener('click', () => {
    const m = document.getElementById('modal-admin-login');
    m.classList.add('hidden');
    m.classList.remove('flex');
  });

  document.getElementById('form-admin-pin')?.addEventListener('submit', async e => {
    e.preventDefault();
    const pin = document.getElementById('input-admin-pin').value.trim();
    const errEl = document.getElementById('admin-pin-error');
    errEl.classList.add('hidden');
    try {
      const res = await fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify_admin', pin })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        errEl.textContent = data.error || 'Invalid Admin PIN';
        errEl.classList.remove('hidden');
        return;
      }
      clientSession.isAdmin = true;
      clientSession.adminToken = data.adminToken || '';
      clientSession.adminPin = pin;
      sessionStorage.setItem(ADMIN_TOKEN_KEY, JSON.stringify({ adminToken: clientSession.adminToken, adminPin: pin }));
      const m = document.getElementById('modal-admin-login');
      m.classList.add('hidden');
      m.classList.remove('flex');
      renderAll();
    } catch (err) {
      errEl.textContent = 'Cannot verify Admin credentials while offline.';
      errEl.classList.remove('hidden');
    }
  });

  // Admin Sales Entry
  document.getElementById('btn-submit-custom-line')?.addEventListener('click', async () => {
    const storeId = document.getElementById('select-line-store').value;
    const category = document.getElementById('select-custom-line-type').value;
    const qty = parseFloat(document.getElementById('input-custom-line-qty').value);
    const note = document.getElementById('input-custom-line-note').value.trim();
    try {
      await postServerAction({ action: 'admin_log_sale', storeId, category, qty, note });
      document.getElementById('input-custom-line-note').value = '';
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('btn-admin-sync-sheet')?.addEventListener('click', async () => {
    try {
      await postServerAction({ action: 'admin_sync_sheet' });
    } catch (err) {
      alert(err.message);
    }
  });

  // Admin Event Lifecycle
  document.getElementById('btn-admin-start-event')?.addEventListener('click', async () => {
    try {
      await postServerAction({ action: 'admin_start_event' });
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('btn-admin-pause-resume')?.addEventListener('click', async () => {
    const isPaused = serverState?.currentEvent?.status === 'PAUSED';
    try {
      await postServerAction({ action: isPaused ? 'admin_resume_event' : 'admin_pause_event' });
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('btn-admin-stop-event')?.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to stop and finalize the current daily event?')) return;
    try {
      await postServerAction({ action: 'admin_stop_event', confirm: true });
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('btn-admin-announce-round')?.addEventListener('click', async () => {
    const mins = parseFloat(document.getElementById('input-bonus-round-minutes').value) || 6;
    const startMs = getServerNowMs() + Math.ceil(mins * 60 * 1000);
    try {
      await postServerAction({ action: 'admin_announce_round', startMs });
    } catch (err) {
      alert(err.message);
    }
  });

  // Admin Audited Corrections & Weekly Ties
  document.getElementById('btn-submit-audit-correction')?.addEventListener('click', async () => {
    const storeId = document.getElementById('select-audit-store').value;
    const ptsVal = document.getElementById('input-audit-points').value.trim();
    const statusVal = document.getElementById('select-audit-status').value;
    const reason = document.getElementById('input-audit-reason').value.trim();
    if (!reason) {
      alert('An audit reason is required!');
      return;
    }
    try {
      if (ptsVal && Number(ptsVal) !== 0) {
        await postServerAction({ action: 'admin_adjust_bonus', storeId, points: Number(ptsVal), reason });
      }
      if (statusVal) {
        await postServerAction({ action: 'admin_correct_store_status', storeId, status: statusVal, reason });
      }
      document.getElementById('input-audit-points').value = '';
      document.getElementById('input-audit-reason').value = '';
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('btn-resolve-weekly-winner')?.addEventListener('click', async () => {
    const winnerStoreId = document.getElementById('select-weekly-winner-store').value;
    const reason = document.getElementById('input-weekly-tie-reason').value.trim();
    try {
      await postServerAction({ action: 'admin_resolve_weekly_tie', winnerStoreId, isSharedResult: false, reason });
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('btn-resolve-weekly-shared')?.addEventListener('click', async () => {
    const reason = document.getElementById('input-weekly-tie-reason').value.trim();
    const tiedIds = serverState?.weeklyStandings?.tiedTopStoreIds || [];
    try {
      await postServerAction({
        action: 'admin_resolve_weekly_tie',
        isSharedResult: true,
        sharedStoreIds: tiedIds,
        reason
      });
    } catch (err) {
      alert(err.message);
    }
  });

  // Save Store Access Codes
  document.getElementById('btn-save-store-codes')?.addEventListener('click', async () => {
    const inputs = document.querySelectorAll('[data-store-code-input]');
    const storeAccessCodes = {};
    inputs.forEach(inp => {
      const id = inp.getAttribute('data-store-code-input');
      const val = inp.value.trim();
      if (id && val) storeAccessCodes[id] = val;
    });
    try {
      await postServerAction({ action: 'admin_set_store_access_codes', storeAccessCodes });
      inputs.forEach(inp => { inp.value = ''; });
      alert('Store Access Codes saved to durable server storage.');
    } catch (err) {
      alert(err.message);
    }
  });

  // Broadcast Banner
  document.getElementById('btn-post-announce')?.addEventListener('click', async () => {
    const text = document.getElementById('input-announce-text').value.trim();
    try {
      await postServerAction({ action: 'admin_set_announcement', text, active: Boolean(text) });
    } catch (err) {
      alert(err.message);
    }
  });
  document.getElementById('btn-clear-announcement')?.addEventListener('click', async () => {
    try {
      await postServerAction({ action: 'admin_set_announcement', text: '', active: false });
    } catch (err) {
      alert(err.message);
    }
  });

  // Sync, PNG Export, Rules, Sound
  document.getElementById('btn-sync-now')?.addEventListener('click', fetchAuthoritativeState);
  document.getElementById('btn-export-png')?.addEventListener('click', exportShareablePngReport);

  document.getElementById('btn-open-rules')?.addEventListener('click', () => {
    const m = document.getElementById('modal-rules');
    m.classList.remove('hidden');
    m.classList.add('flex');
  });
  document.getElementById('btn-close-rules')?.addEventListener('click', () => {
    const m = document.getElementById('modal-rules');
    m.classList.add('hidden');
    m.classList.remove('flex');
  });

  const soundBtn = document.getElementById('btn-sound-toggle');
  soundBtn?.addEventListener('click', () => {
    clientSession.soundEnabled = !clientSession.soundEnabled;
    soundBtn.textContent = clientSession.soundEnabled ? '🔊' : '🔇';
  });
});
