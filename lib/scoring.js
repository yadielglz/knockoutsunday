/**
 * Knockout Blitz — Fixed-Precision Point Scoring & Integer Money Accounting
 *
 * Units:
 * - Money is stored in integer cents (accCents: $1.00 = 100 cents).
 * - Points are stored in exact integer Basis Points (bp: 1 point = 100 bp)
 *   AND exposed as exact decimal numbers / formatted strings without silent rounding.
 *   Since $1.00 (100 cents) = 2 points (200 bp), 1 cent = 2 bp (0.02 points) — 100% exact integer math!
 *
 * Point System:
 * - Standard VL Activation: 200 points
 * - Watch or Tablet (BTS): 200 points each
 * - HINT / HSI: 600 points each
 * - Accessories: 2 points per $1.00 immediately (no $100 threshold)
 * - Sales Milestone Bonus: For every 300 base sales points earned, the store gets an extra +300 points!
 */

const BP_PER_POINT = 100;

const POINTS_CONFIG = {
  VL_POINTS: 200,
  BTS_POINTS: 200,                     // Watch or Tablet
  HSI_POINTS: 600,                     // HINT / HSI (600 points each)
  ACC_POINTS_PER_DOLLAR: 2,            // 2 points per $1.00 (2 bp per cent)
  SALES_MILESTONE_STEP_POINTS: 300,    // Every 300 base sales points earned
  SALES_MILESTONE_BONUS_POINTS: 300,   // Awards +300 extra points
  NORMAL_ATTACK_COST: 200,
  NORMAL_ATTACK_DAMAGE: 400,
  DEFLECTED_SIMPLE_COST: 200,
  DEFLECTED_SIMPLE_DAMAGE: 100,
  DEFLECTION_BREAKER_COST: 400,
  DEFLECTION_BREAKER_DAMAGE: 500,       // 1.25 * 400
  DEFLECTION_MIN_AVAILABLE: 1350,
  POWER_PHASE_MIN_AVAILABLE: 350,
  SHIELD_COST: 600,
  REVIVE_OUTSIDE_ROUND_COST: 200,
  REVIVE_DURING_ROUND_COST: 400
};

/**
 * Parse a dollar string or number (e.g. "$1,305", "25.50", 120) into exact integer cents.
 */
function parseDollarsToCents(input) {
  if (input === null || input === undefined || input === '') return 0;
  const str = String(input).replace(/[$,\s]/g, '').trim();
  if (!str || str.includes('#DIV/0!') || str.includes('#VALUE!')) return 0;
  const match = str.match(/^(-?)(\d+)(?:\.(\d{1,2})\d*)?$/);
  if (!match) {
    const num = Number(str);
    if (!Number.isFinite(num)) return 0;
    return Math.round(num * 100);
  }
  const sign = match[1] === '-' ? -1 : 1;
  const wholeDollars = parseInt(match[2], 10);
  const fracStr = (match[3] || '').padEnd(2, '0');
  const cents = parseInt(fracStr, 10);
  return sign * (wholeDollars * 100 + cents);
}

/**
 * Format integer cents to display string (e.g., "$120" or "$25.50").
 */
function formatCentsToDollars(cents) {
  const c = Number(cents || 0);
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  const dollars = Math.floor(abs / 100);
  const remCents = abs % 100;
  if (remCents === 0) {
    return `${sign}$${dollars.toLocaleString('en-US')}`;
  }
  return `${sign}$${dollars.toLocaleString('en-US')}.${String(remCents).padStart(2, '0')}`;
}

/**
 * Convert whole or decimal points into exact integer basis points (1 pt = 100 bp).
 */
function pointsToBp(pts) {
  if (pts === null || pts === undefined || pts === '') return 0;
  if (typeof pts === 'number') {
    return Math.round(pts * BP_PER_POINT);
  }
  const str = String(pts).trim();
  const match = str.match(/^(-?)(\d+)(?:\.(\d{1,2})\d*)?$/);
  if (!match) return Math.round(Number(str) * BP_PER_POINT) || 0;
  const sign = match[1] === '-' ? -1 : 1;
  const whole = parseInt(match[2], 10);
  const frac = parseInt((match[3] || '').padEnd(2, '0'), 10);
  return sign * (whole * BP_PER_POINT + frac);
}

/**
 * Convert basis points to exact numeric points (e.g., 5000 bp -> 50, 2050 bp -> 20.5).
 */
function bpToPoints(bp) {
  const val = Number(bp || 0);
  return val / BP_PER_POINT;
}

/**
 * Format basis points for UI display without silent rounding of fractional points.
 */
function formatBp(bp) {
  const val = Number(bp || 0);
  const sign = val < 0 ? '-' : '';
  const abs = Math.abs(val);
  const whole = Math.floor(abs / BP_PER_POINT);
  const rem = abs % BP_PER_POINT;
  if (rem === 0) {
    return `${sign}${whole.toLocaleString('en-US')}`;
  }
  const dec = rem % 10 === 0 ? String(rem / 10) : String(rem).padStart(2, '0');
  return `${sign}${whole.toLocaleString('en-US')}.${dec}`;
}

/**
 * Compute sales-earned basis points from quantities and accessory cents.
 *
 * Rules:
 * - totalVl: VL activations, 200 points each (20,000 bp).
 * - bts: Watches + Tablets, 200 points each (20,000 bp).
 * - hsi: HINT / HSI activations, 600 points each (60,000 bp).
 * - accCents: Integer cents of accessories. 1 cent = 2 bp ($1.00 = 2 points).
 * - Sales Milestone Bonus: For every 300 base sales points (30,000 bp) earned,
 *   award an extra +300 points (30,000 bp).
 *   (Wait: if disableMilestoneBonus is passed as true for raw base calculation, milestoneBonusBp is 0.)
 */
function calculateSalesPointsBp({
  totalVl = 0,
  bts = 0,
  hsi = 0,
  accCents = 0,
  includeMilestoneBonus = true
}) {
  const safeTotalVl = Math.max(0, Math.trunc(Number(totalVl || 0)));
  const safeBts = Math.max(0, Math.trunc(Number(bts || 0)));
  const safeHsi = Math.max(0, Math.trunc(Number(hsi || 0)));
  const safeAccCents = Math.max(0, Math.trunc(Number(accCents || 0)));

  const vlBp = safeTotalVl * POINTS_CONFIG.VL_POINTS * BP_PER_POINT;
  const btsBp = safeBts * POINTS_CONFIG.BTS_POINTS * BP_PER_POINT;
  const hsiBp = safeHsi * POINTS_CONFIG.HSI_POINTS * BP_PER_POINT;
  const accBp = safeAccCents * 2; // 100 cents ($1) = 200 bp (2 points)

  const baseSalesBp = vlBp + btsBp + hsiBp + accBp;

  const stepBp = POINTS_CONFIG.SALES_MILESTONE_STEP_POINTS * BP_PER_POINT; // 30,000 bp (300 pts)
  const bonusPerStepBp = POINTS_CONFIG.SALES_MILESTONE_BONUS_POINTS * BP_PER_POINT; // 30,000 bp (300 pts)
  const milestoneCount = includeMilestoneBonus ? Math.floor(baseSalesBp / stepBp) : 0;
  const milestoneBonusBp = milestoneCount * bonusPerStepBp;

  const totalSalesBp = baseSalesBp + milestoneBonusBp;

  return {
    totalVl: safeTotalVl,
    bts: safeBts,
    hsi: safeHsi,
    accCents: safeAccCents,
    vlBp,
    btsBp,
    hsiBp,
    accBp,
    baseSalesBp,
    baseSalesPoints: bpToPoints(baseSalesBp),
    milestoneCount,
    milestoneBonusBp,
    milestoneBonusPoints: bpToPoints(milestoneBonusBp),
    totalSalesBp,
    totalSalesPoints: bpToPoints(totalSalesBp)
  };
}

module.exports = {
  BP_PER_POINT,
  POINTS_CONFIG,
  parseDollarsToCents,
  formatCentsToDollars,
  pointsToBp,
  bpToPoints,
  formatBp,
  calculateSalesPointsBp
};
