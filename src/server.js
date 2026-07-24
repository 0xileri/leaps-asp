import express from "express";
import { fileURLToPath } from "node:url";
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

// human-facing landing page (public/): reviewers and the curious open the bare
// URL in a browser; without this the API answers 404 and looks dead.
app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

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
