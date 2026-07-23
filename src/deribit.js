// deribit public API layer. no auth needed for any of these.
// docs: https://docs.deribit.com  (public/get_index_price, public/get_book_summary_by_currency,
// public/ticker, public/get_instruments — all plain GET on /api/v2)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE = "https://www.deribit.com/api/v2";
const MOCK = process.env.MOCK === "1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- tiny in-memory cache (chain data is heavy; hold it 120s) ----
const cache = new Map();
const TTL_MS = { chain: 120_000, spot: 30_000 };

function getCached(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < hit.ttl) return hit.v;
  return null;
}
function setCached(key, v, ttl) {
  cache.set(key, { v, t: Date.now(), ttl });
}

async function rpc(method, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/public/${method}?${qs}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`deribit ${method} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`deribit ${method} -> ${JSON.stringify(body.error)}`);
  return body.result;
}

function loadFixture(name) {
  return JSON.parse(readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8"));
}

const INDEX_NAME = { BTC: "btc_usd", ETH: "eth_usd", SOL: "sol_usd" };

export async function getSpot(asset) {
  if (MOCK) return loadFixture(`${asset.toLowerCase()}-spot.json`).index_price;
  const key = `spot:${asset}`;
  const hit = getCached(key);
  if (hit) return hit;
  const r = await rpc("get_index_price", { index_name: INDEX_NAME[asset] });
  setCached(key, r.index_price, TTL_MS.spot);
  return r.index_price;
}

// full option chain summary for a currency: instrument_name, mark_price (in coin),
// mark_iv, open_interest, bid/ask, underlying_price
export async function getChain(asset) {
  if (MOCK) return loadFixture(`${asset.toLowerCase()}-chain.json`);
  const key = `chain:${asset}`;
  const hit = getCached(key);
  if (hit) return hit;
  const r = await rpc("get_book_summary_by_currency", { currency: asset, kind: "option" });
  setCached(key, r, TTL_MS.chain);
  return r;
}

// live ticker for one instrument: greeks {delta,gamma,vega,theta,rho}, mark_iv, mark_price
export async function getTicker(instrumentName) {
  if (MOCK) {
    const tickers = loadFixture("tickers.json");
    const t = tickers[instrumentName];
    if (!t) throw new Error(`no mock ticker for ${instrumentName}`);
    return t;
  }
  return rpc("ticker", { instrument_name: instrumentName });
}

// parse "BTC-26MAR27-120000-C" -> { asset, expiry: Date, strike, type }
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
export function parseInstrument(name) {
  const m = name.match(/^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/);
  if (!m) return null;
  const [, asset, day, mon, yy, strike, type] = m;
  const expiry = new Date(Date.UTC(2000 + Number(yy), MONTHS[mon], Number(day), 8, 0, 0)); // deribit expiries settle 08:00 UTC
  return { asset, expiry, strike: Number(strike), type };
}
