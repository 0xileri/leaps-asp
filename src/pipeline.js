// shared request parsing + pipeline. both the REST endpoints and the MCP tools
// run through this, so there is exactly one code path to trust.

import { getSpot, getChain, getTicker } from "./deribit.js";
import { selectCandidates } from "./filter.js";
import { structurePosition, structureDeterministic } from "./structure.js";

const ASSETS = new Set(["BTC", "ETH"]);
const CONVICTIONS = new Set(["low", "medium", "high"]);

export function parseRequest(body) {
  const errors = [];
  const asset = String(body.asset ?? "").toUpperCase();
  if (asset === "SOL") {
    errors.push("SOL not supported in v1: Deribit SOL options are linear USDC-settled with different naming/quoting than the inverse BTC/ETH chain. planned for v2.");
  } else if (!ASSETS.has(asset)) errors.push("asset must be BTC | ETH");
  const capital = Number(body.capital_usd);
  if (!(capital > 0)) errors.push("capital_usd must be a positive number");
  let horizon = Number(body.horizon_months ?? 12);
  if (!(horizon >= 2 && horizon <= 36)) errors.push("horizon_months must be 2-36");
  const conviction = CONVICTIONS.has(body.conviction) ? body.conviction : "medium";
  const thesis = String(body.thesis ?? "").slice(0, 1000);
  return { errors, req: { asset, capital_usd: capital, horizon_months: horizon, conviction, thesis, direction: "long" } };
}

export async function runPipeline(req, opts = {}) {
  const [spot, chain] = await Promise.all([getSpot(req.asset), getChain(req.asset)]);
  const sel = selectCandidates({
    chain,
    asset: req.asset,
    spot,
    horizonMonths: req.horizon_months,
    conviction: req.conviction,
  });
  if (sel.candidates.length === 0) {
    const e = new Error(`no structurable ${req.asset} contracts found for that horizon`);
    e.status = 422;
    throw e;
  }
  const tickers = {};
  await Promise.all(
    sel.candidates.map(async (c) => {
      tickers[c.instrument_name] = await getTicker(c.instrument_name);
    })
  );
  return structurePosition({ req, spot, ...sel, tickers, deterministicOnly: !!opts.deterministicOnly });
}

// truncated shape used by the free preview surfaces (REST /preview + MCP preview tool)
export function toPreview(full) {
  return {
    asset: full.asset,
    spot_usd: full.spot_usd,
    recommended: {
      instrument: full.recommended.instrument,
      strike_usd: full.recommended.strike_usd,
      expiry: full.recommended.expiry,
      mark_iv_pct: full.recommended.mark_iv_pct,
    },
    note: "full structure (sizing, premium, breakeven, greeks, scenarios) available on the paid structure_leaps_position tool / POST /structure",
    disclaimer: full.disclaimer,
  };
}
