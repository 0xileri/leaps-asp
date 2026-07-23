// the structuring engine. two paths:
//  - model path: Claude picks among the real candidates and writes sizing/scenarios/notes.
//  - deterministic path: pure-code structurer. used in MOCK mode, and as the
//    fallback if the model output fails schema validation twice.
// either way the response is validated before it leaves the process.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const MOCK = process.env.MOCK === "1";

// ---------- shared math ----------
// deribit BTC/ETH options are coin-settled: mark_price is quoted in the coin.
// USD premium = mark_price * spot. miss this and every number is wrong by ~spot.
function premiumUsd(c, spot) {
  return c.mark_price * spot;
}

function scenarioReturnPct({ underlyingAtExpiry, strike, premiumPerContractUsd }) {
  const intrinsic = Math.max(0, underlyingAtExpiry - strike);
  return Math.round(((intrinsic - premiumPerContractUsd) / premiumPerContractUsd) * 100);
}

function buildScenarios(spot, strike, premiumPerContractUsd, conviction) {
  const bullMult = conviction === "high" ? 2.0 : conviction === "medium" ? 1.7 : 1.5;
  const cases = [
    { case: "bull", underlying_at_expiry: Math.round(spot * bullMult) },
    { case: "base", underlying_at_expiry: Math.round(spot * 1.25) },
    { case: "bear", underlying_at_expiry: Math.round(spot * 0.7) },
  ];
  return cases.map((c) => ({
    ...c,
    est_return_pct: scenarioReturnPct({
      underlyingAtExpiry: c.underlying_at_expiry,
      strike,
      premiumPerContractUsd,
    }),
  }));
}

// deribit minimum trade sizes differ by asset: BTC options step in 0.1-contract
// increments, ETH options trade in whole contracts.
const SIZE = { BTC: { min: 0.1, step: 0.1 }, ETH: { min: 1, step: 1 } };

// ---------- deterministic structurer ----------
export function structureDeterministic({ req, spot, candidates, tickers, horizonCapped, maxListedDays }) {
  // score: prefer delta ~0.55 (classic long-LEAPS zone), tilt further OTM with conviction
  const targetDelta = req.conviction === "high" ? 0.45 : req.conviction === "low" ? 0.65 : 0.55;
  let best = null;
  for (const c of candidates) {
    const t = tickers[c.instrument_name];
    if (!t) continue;
    const score = -Math.abs((t.greeks?.delta ?? 0.5) - targetDelta);
    if (!best || score > best.score) best = { c, t, score };
  }
  if (!best) throw new Error("no structurable candidate");

  const { c, t } = best;
  const size = SIZE[req.asset] ?? { min: 0.1, step: 0.1 };
  const premPerContract = premiumUsd(c, spot);
  const rawCount = req.capital_usd / premPerContract;
  const contractCount = Math.max(size.min, Math.round(Math.floor(rawCount / size.step) * size.step * 10) / 10);

  const riskFlags = [];
  if (horizonCapped) {
    riskFlags.push(
      `requested ${req.horizon_months}m horizon exceeds the longest listed expiry (~${Math.round(maxListedDays / 30)}m); structured against the longest available contract`
    );
  }
  riskFlags.push("coin-settled inverse contract; premium and breakeven converted to USD at current spot");
  if (rawCount < size.min) {
    riskFlags.push(`capital of $${req.capital_usd} is below one minimum-size (${size.min}) ${req.asset} contract at this premium`);
  }

  const dte = Math.round(c.dte);
  return {
    asset: req.asset,
    spot_usd: round2(spot),
    recommended: {
      instrument: c.instrument_name,
      strike_usd: c.strike,
      expiry: c.expiry.toISOString().slice(0, 10),
      days_to_expiry: dte,
      est_premium_usd: round2(premPerContract),
      contract_count: contractCount,
      breakeven_usd: Math.round(c.strike + premPerContract),
      greeks: {
        delta: round3(t.greeks?.delta ?? null),
        theta: round2(t.greeks?.theta ?? null),
        vega: round2(t.greeks?.vega ?? null),
      },
      mark_iv_pct: round1(t.mark_iv ?? c.mark_iv ?? null),
    },
    scenarios: buildScenarios(spot, c.strike, premPerContract, req.conviction),
    entry_notes: `structured deterministically: delta ${round2(t.greeks?.delta)} contract closest to the ${targetDelta} target for ${req.conviction} conviction at the ${dte}-day expiry.`,
    roll_trigger: "review roll 120-180 days before expiry, or earlier if delta exceeds 0.80",
    risk_flags: riskFlags,
    disclaimer: "analysis only, not financial advice",
  };
}

// ---------- model structurer ----------
const SYSTEM_PROMPT = `You are an options structuring engine for long-dated (LEAPS-style) call positions on crypto assets.

You receive:
- a user's directional thesis, time horizon, conviction level, and capital in USD
- the current spot price
- a list of REAL, currently listed call option candidates with live strike, expiry, days-to-expiry, mark price (quoted in the coin), mark IV, open interest, and greeks

Rules:
1. Choose exactly ONE candidate from the provided list. NEVER invent, modify, or combine instruments.
2. USD premium per contract = mark_price * spot (these are coin-settled contracts). Breakeven = strike + USD premium per contract.
3. contract_count = capital / USD premium per contract, floored to the min_contract_size step provided in the input, minimum min_contract_size.
4. Scenarios use intrinsic value at expiry only: return% = (max(0, underlying - strike) - premium) / premium * 100, rounded to integers.
5. entry_notes: 1-2 sentences on why this strike/expiry fits the thesis and conviction, referencing the IV level.
6. If a "horizon_capped" flag is set, the first risk_flag must state that the requested horizon exceeds the longest listed expiry.
7. Always include the coin-settlement conversion note in risk_flags.
8. This is analysis, not advice. The disclaimer field is mandatory.

Respond with ONLY a JSON object matching this exact schema — no markdown, no prose, no code fences:
{"asset":string,"spot_usd":number,"recommended":{"instrument":string,"strike_usd":number,"expiry":"YYYY-MM-DD","days_to_expiry":number,"est_premium_usd":number,"contract_count":number,"breakeven_usd":number,"greeks":{"delta":number,"theta":number,"vega":number},"mark_iv_pct":number},"scenarios":[{"case":"bull"|"base"|"bear","underlying_at_expiry":number,"est_return_pct":number}],"entry_notes":string,"roll_trigger":string,"risk_flags":[string],"disclaimer":"analysis only, not financial advice"}`;

async function callClaude(userPayload) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(userPayload) }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const text = (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text.replace(/^```(json)?|```$/g, "").trim());
}

export async function structurePosition(ctx) {
  const { req, spot, candidates, tickers, horizonCapped, maxListedDays, chosenExpiry } = ctx;

  if (MOCK || ctx.deterministicOnly || !process.env.ANTHROPIC_API_KEY) {
    return structureDeterministic(ctx);
  }

  const minSize = (SIZE[req.asset] ?? { min: 0.1 }).min;
  const payload = {
    min_contract_size: minSize,
    thesis: req.thesis,
    asset: req.asset,
    horizon_months: req.horizon_months,
    conviction: req.conviction,
    capital_usd: req.capital_usd,
    spot_usd: spot,
    horizon_capped: horizonCapped,
    max_listed_days: maxListedDays,
    chosen_expiry: chosenExpiry?.toISOString().slice(0, 10),
    candidates: candidates.map((c) => ({
      instrument: c.instrument_name,
      strike: c.strike,
      expiry: c.expiry.toISOString().slice(0, 10),
      days_to_expiry: Math.round(c.dte),
      mark_price_coin: c.mark_price,
      mark_iv_pct: tickers[c.instrument_name]?.mark_iv ?? c.mark_iv ?? null,
      open_interest: c.open_interest ?? null,
      greeks: tickers[c.instrument_name]?.greeks ?? null,
    })),
  };

  // model path with one retry, then deterministic fallback. never return unvalidated output.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await callClaude(payload);
      const err = validateResponse(out, candidates, minSize);
      if (!err) return out;
      console.warn(`model output failed validation (attempt ${attempt + 1}): ${err}`);
    } catch (e) {
      console.warn(`model call failed (attempt ${attempt + 1}): ${e.message}`);
    }
  }
  return structureDeterministic(ctx);
}

// ---------- validation ----------
export function validateResponse(o, candidates, minSize = 0.1) {
  try {
    if (typeof o !== "object" || o === null) return "not an object";
    const r = o.recommended;
    if (!r) return "missing recommended";
    if (!candidates.some((c) => c.instrument_name === r.instrument)) return `instrument ${r.instrument} not in candidate set`;
    for (const k of ["strike_usd", "est_premium_usd", "contract_count", "breakeven_usd", "days_to_expiry"]) {
      if (typeof r[k] !== "number" || !isFinite(r[k])) return `bad ${k}`;
    }
    if (!Array.isArray(o.scenarios) || o.scenarios.length !== 3) return "need 3 scenarios";
    if (!Array.isArray(o.risk_flags) || o.risk_flags.length === 0) return "risk_flags required";
    if (o.disclaimer !== "analysis only, not financial advice") return "disclaimer missing/altered";
    if (r.contract_count < minSize) return "contract_count below deribit minimum for this asset";
    return null;
  } catch (e) {
    return e.message;
  }
}

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const round3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);
