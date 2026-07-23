# leaps-asp

thesis-to-structure LEAPS options analysis as a pay-per-call service. an agent sends a directional thesis, horizon, conviction, and capital; it gets back a fully structured long-dated call position built from real, currently listed Deribit contracts: strike, expiry, USD premium, sizing, breakeven, greeks, and bull/base/bear scenarios. built as an A2MCP Agent Service Provider for OKX.AI.

## surfaces

### A2MCP (the one you list on OKX.AI)
`POST /mcp` speaks the MCP protocol (streamable HTTP, stateless, JSON responses). two tools:

- `preview_leaps_structure` — free. deterministic engine, truncated output. lets any buyer agent discover and verify the service before paying.
- `structure_leaps_position` — paid per call. full structure: instrument, strike, expiry, USD premium, sizing, breakeven, greeks, mark IV, bull/base/bear scenarios, entry notes, roll trigger, risk flags.

payment is gated per tool call, not per route: `initialize`, `tools/list`, and the free preview pass untouched; only a `tools/call` on `structure_leaps_position` hits the x402 gate (402 challenge -> pay -> retry with `X-PAYMENT` -> 200). when you create the A2MCP service in the OKX listing flow, point it at `https://<your-host>/mcp`.

### REST (kept for curl, debugging, non-MCP callers)
- `POST /preview` — free. same pipeline, truncated output (instrument + strike + expiry + IV, no sizing/scenarios). lets a buyer agent verify the service before paying. preview runs the deterministic structurer only and never spends model tokens, so the free endpoint can't be used to drain your Anthropic credits.
- `POST /structure` — paid ($0.30/call default). same engine as the paid tool.
- `GET /health` — liveness.

### request
```json
{
  "asset": "BTC",
  "thesis": "new ATH within 18 months driven by ETF inflows",
  "horizon_months": 18,
  "conviction": "high",
  "capital_usd": 5000
}
```
`asset` (BTC|ETH) and `capital_usd` are required. `conviction` defaults to medium, `horizon_months` to 12.

### response
see `test/run-mock.js` output for the exact shape. every response is schema-validated before it leaves the process; the model can only choose among real contracts pre-filtered in code, so it cannot invent an instrument.

## how it works

1. pull spot (`public/get_index_price`) and the full option chain (`public/get_book_summary_by_currency`) from Deribit's public API. no key needed. chain cached 120s.
2. deterministic pre-filter in code: calls only, listed expiry closest to the horizon, strike band scaled by conviction, liquidity-ranked, max 6 candidates.
3. live greeks + mark IV per candidate via `public/ticker`.
4. Claude (`claude-sonnet-4-6`) picks the best structure, sizes it, writes scenarios and notes, returns strict JSON. one retry on validation failure, then a pure-code deterministic structurer takes over. the service never returns unvalidated model output and never goes down because the model did.

## run it

```bash
npm install
npm run test:mock              # offline end-to-end test on fixture data (BTC)
MOCK=0 ANTHROPIC_API_KEY=sk-.. PAYMENT_MODE=off npm start   # live data, open endpoint
```

env (see `.env.example`): `ANTHROPIC_API_KEY` (backend only, never client-side), `PAYMENT_MODE` (`off` | `demo` | `live`), `PRICE_USD`, `PAY_TO_ADDRESS`, `PORT`, `MOCK`, `CLAUDE_MODEL`.

## payments (x402 / OKX)

flow: caller hits `/structure` → 402 with an x402 payment-requirements challenge → caller's agent pays → retries with the payment header → verify/settle via the OKX facilitator → 200 (+ `PAYMENT-RESPONSE` header). settlement in USDT0 on X Layer.

- `PAYMENT_MODE=demo` fakes this shape for local testing (no real verification).
- `PAYMENT_MODE=live` is real: `src/payment.js` builds OKX's seller middleware (`@okxweb3/x402-express` + `@okxweb3/x402-core` + `@okxweb3/x402-evm`, from github.com/okx/payments) with the `exact` scheme on X Layer (`X402_NETWORK`, default mainnet `eip155:196`). requires `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` (facilitator credentials from the OKX developer platform) and `PAY_TO_ADDRESS` (your receiving wallet). the server fails fast at boot if any are missing. price comes from `PRICE_USD` (USD string, auto-converted to USDT0 atomic units by the SDK).

buyer side (for the demo): an agent with `okx-agent-payments-protocol` installed pays via `onchainos payment quote <url>` → confirm → `payment pay --payment-id --yes`, which signs, replays, and returns the settled receipt.

## deploy + list on OKX.AI

1. deploy to Railway/Render. secrets as env vars only. confirm `/health`, a live `/preview`, and the 402→200 round-trip.
2. via your agent: install Onchain OS, set up the Agentic Wallet (email needed), register as an ASP, create an A2MCP pay-per-call service pointing at your `/structure` URL.
3. submit for OKX review early — the ASP must pass review and go live or the hackathon entry is invalid.
4. hackathon: 90s demo of an agent calling + paying + receiving the structure, post on X with #okxai, submit the Google form before Jul 27 (plan for Jul 26 — official sources say 23:59 UTC but treat the earlier reading as the deadline).

## honest constraints

- Deribit lists options out to roughly 12–13 months, not 24. longer horizons are structured against the longest real expiry and flagged in `risk_flags`, never faked.
- BTC/ETH options are coin-settled: mark price is quoted in the coin. USD premium = mark × spot; the conversion is always flagged in the output.
- SOL is deliberately out of v1: Deribit SOL options are linear USDC-settled with different naming and quoting than the inverse BTC/ETH chain, so bolting them on untested risks premiums wrong by ~100x. the endpoint rejects SOL with a clear message; v2 work.
- this is analysis, not financial advice, and every response says so. keep the listing copy and demo framed the same way.
