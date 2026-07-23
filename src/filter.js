// deterministic candidate selection. code picks the real contracts,
// the model only ever chooses among them — it cannot invent an instrument.

import { parseInstrument } from "./deribit.js";

const DAY_MS = 86_400_000;

// strike band relative to spot, widened by conviction.
// higher conviction -> tolerate further OTM (cheaper premium, more leverage).
const STRIKE_BAND = {
  low: { min: 0.95, max: 1.2 },
  medium: { min: 0.98, max: 1.45 },
  high: { min: 1.0, max: 1.8 },
};

export function selectCandidates({ chain, asset, spot, horizonMonths, conviction }) {
  const now = Date.now();
  const targetDays = horizonMonths * 30.44;

  // 1. parse + keep live calls with a usable mark
  const calls = [];
  for (const row of chain) {
    const p = parseInstrument(row.instrument_name);
    if (!p || p.type !== "C" || p.asset !== asset) continue;
    const dte = (p.expiry.getTime() - now) / DAY_MS;
    if (dte <= 30) continue; // nothing short-dated; this is a LEAPS service
    if (!(row.mark_price > 0)) continue;
    calls.push({ ...row, ...p, dte });
  }
  if (calls.length === 0) return { candidates: [], chosenExpiry: null, horizonCapped: false, maxListedDays: 0 };

  // 2. pick the listed expiry closest to the requested horizon.
  //    deribit's furthest listed expiry is typically ~12-13 months out, so an
  //    18-24m request gets capped to the longest real expiry — flagged, never faked.
  const expiries = [...new Set(calls.map((c) => c.expiry.getTime()))].sort((a, b) => a - b);
  const maxListedDays = (expiries[expiries.length - 1] - now) / DAY_MS;
  const horizonCapped = targetDays > maxListedDays + 15;
  const targetTs = now + Math.min(targetDays, maxListedDays) * DAY_MS;
  const chosenExpiryTs = expiries.reduce((best, e) =>
    Math.abs(e - targetTs) < Math.abs(best - targetTs) ? e : best
  );

  // 3. strike band by conviction, on that expiry only
  const band = STRIKE_BAND[conviction] ?? STRIKE_BAND.medium;
  let pool = calls.filter(
    (c) => c.expiry.getTime() === chosenExpiryTs && c.strike >= spot * band.min && c.strike <= spot * band.max
  );

  // 4. degrade gracefully on thin chains (SOL far-dated, mostly):
  //    widen the band before giving up.
  if (pool.length < 3) {
    pool = calls.filter(
      (c) => c.expiry.getTime() === chosenExpiryTs && c.strike >= spot * 0.85 && c.strike <= spot * 2.2
    );
  }

  // 5. prefer liquidity, cap at 6 candidates spread across the strike range
  pool.sort((a, b) => (b.open_interest ?? 0) - (a.open_interest ?? 0));
  pool = pool.slice(0, 10);
  pool.sort((a, b) => a.strike - b.strike);
  const step = Math.max(1, Math.floor(pool.length / 6));
  const candidates = pool.filter((_, i) => i % step === 0).slice(0, 6);

  return {
    candidates,
    chosenExpiry: new Date(chosenExpiryTs),
    horizonCapped,
    maxListedDays: Math.round(maxListedDays),
  };
}
