import express from "express";
import { parseRequest, runPipeline, toPreview } from "./pipeline.js";
import { paymentGate, initPayments } from "./payment.js";
import { handleMcpRequest, isPaidMcpCall } from "./mcp.js";

const app = express();
app.use(express.json({ limit: "16kb" }));

// ---------- REST surface (kept for curl/debugging and non-MCP callers) ----------

// free taste: deterministic-only — the free endpoint must never spend model
// tokens, or it becomes an open cost-leak anyone can hammer.
app.post("/preview", async (req, res) => {
  const { errors, req: parsed } = parseRequest(req.body ?? {});
  if (errors.length) return res.status(400).json({ errors });
  try {
    const full = await runPipeline(parsed, { deterministicOnly: true });
    res.json(toPreview(full));
  } catch (e) {
    res.status(e.status ?? 502).json({ error: e.message });
  }
});

// paid endpoint. paymentGate is the x402 integration point — see src/payment.js.
app.post("/structure", paymentGate, async (req, res) => {
  const { errors, req: parsed } = parseRequest(req.body ?? {});
  if (errors.length) return res.status(400).json({ errors });
  try {
    const full = await runPipeline(parsed);
    res.json(full);
  } catch (e) {
    res.status(e.status ?? 502).json({ error: e.message });
  }
});

// ---------- A2MCP surface ----------
// one endpoint speaking the MCP protocol (streamable HTTP, stateless).
// payment is gated per tool call: only structure_leaps_position requires it,
// so discovery (initialize, tools/list) and the free preview tool stay open.
app.post("/mcp", (req, res, next) => {
  if (isPaidMcpCall(req.body)) return paymentGate(req, res, next);
  next();
}, (req, res) => {
  handleMcpRequest(req, res).catch((e) => {
    console.error("mcp error:", e);
    if (!res.headersSent) res.status(500).json({ error: "internal mcp error" });
  });
});

// stateless server: no SSE stream to resume, no sessions to delete.
app.get("/mcp", (_req, res) => res.status(405).json({ error: "stateless MCP: POST only" }));
app.delete("/mcp", (_req, res) => res.status(405).json({ error: "stateless MCP: POST only" }));

// human-facing landing page: reviewers and the curious open the bare URL in a
// browser; without this the API answers 404 and looks dead.
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LEAPSY — leaps-asp</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0b0f0c;color:#e6efe8;max-width:680px;margin:8vh auto;padding:0 20px;line-height:1.6}
  h1{color:#7ed957;margin-bottom:0} .sub{color:#9db3a4;margin-top:4px}
  code{background:#16201a;padding:2px 6px;border-radius:4px;color:#a8e6a1}
  table{border-collapse:collapse;margin:1em 0} td{padding:6px 12px 6px 0;vertical-align:top}
  .free{color:#7ed957} .paid{color:#f0c674} .dim{color:#9db3a4;font-size:.9em}
</style></head><body>
<h1>LEAPSY</h1>
<p class="sub">thesis-to-structure LEAPS options analysis · pay-per-call A2MCP service</p>
<p>Send a directional thesis, horizon, conviction and capital; get back a fully structured
long-dated call position built from real, currently listed Deribit contracts —
strike, expiry, USD premium, sizing, breakeven, greeks, and bull/base/bear scenarios.</p>
<table>
<tr><td><code>POST /mcp</code></td><td>A2MCP endpoint — <span class="free">free</span> <code>preview_leaps_structure</code>, <span class="paid">paid</span> <code>structure_leaps_position</code> (x402)</td></tr>
<tr><td><code>POST /preview</code></td><td><span class="free">free</span> REST preview</td></tr>
<tr><td><code>POST /structure</code></td><td><span class="paid">paid</span> REST full structure (x402)</td></tr>
<tr><td><code>GET /health</code></td><td>liveness</td></tr>
</table>
<p class="dim">Assets: BTC, ETH · Fee: 0.1 USDT per structure call · Analysis only, not financial advice.</p>
</body></html>`);
});

app.get("/health", (_req, res) =>
  res.json({ ok: true, mock: process.env.MOCK === "1", service: "leaps-asp", version: "1.0.0", mcp: "/mcp" })
);

// JSON error handler — payment-middleware failures (e.g. facilitator unreachable)
// must surface as clean JSON, never express's default HTML stack page.
app.use((err, _req, res, _next) => {
  console.error("unhandled:", err.message);
  if (!res.headersSent) res.status(502).json({ error: "payment gate error", detail: err.message });
});

const PORT = process.env.PORT || 3000;
// fail fast on bad payment config: in live mode the facilitator middleware is
// built (and credentials checked) before we accept traffic.
initPayments()
  .then(() => {
    app.listen(PORT, () =>
      console.log(
        `leaps-asp listening on :${PORT} (mock=${process.env.MOCK === "1"}, payments=${process.env.PAYMENT_MODE || "off"}) — REST: /preview /structure, MCP: /mcp`
      )
    );
  })
  .catch((e) => {
    console.error("payment init failed:", e.message);
    process.exit(1);
  });
