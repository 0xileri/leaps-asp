// A2MCP layer: exposes the pipeline as MCP tools over streamable HTTP.
// stateless mode — a fresh server+transport per request, JSON responses on,
// so any MCP-speaking buyer agent can discover and call the tools with plain POSTs.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { parseRequest, runPipeline, toPreview } from "./pipeline.js";

const inputShape = {
  asset: z.enum(["BTC", "ETH"]).describe("underlying asset"),
  thesis: z.string().max(1000).optional().describe("the directional thesis in plain language"),
  horizon_months: z.number().min(2).max(36).optional().describe("desired time horizon in months (default 12)"),
  conviction: z.enum(["low", "medium", "high"]).optional().describe("conviction level; higher tolerates further-OTM strikes (default medium)"),
  capital_usd: z.number().positive().describe("capital to allocate in USD"),
};

function asToolResult(obj, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], isError };
}

async function runTool(args, opts) {
  const { errors, req } = parseRequest(args ?? {});
  if (errors.length) return asToolResult({ errors }, true);
  try {
    const full = await runPipeline(req, opts);
    return asToolResult(opts.deterministicOnly ? toPreview(full) : full);
  } catch (e) {
    return asToolResult({ error: e.message }, true);
  }
}

export function buildMcpServer() {
  const server = new McpServer({ name: "leaps-asp", version: "1.0.0" });

  server.registerTool(
    "preview_leaps_structure",
    {
      title: "Preview LEAPS structure (free)",
      description:
        "Free preview: given an asset, thesis, horizon, conviction and capital, returns the recommended real Deribit LEAPS call (instrument, strike, expiry, mark IV) without sizing, premium, breakeven, greeks or scenarios. Deterministic engine only. Analysis, not financial advice.",
      inputSchema: inputShape,
    },
    (args) => runTool(args, { deterministicOnly: true })
  );

  server.registerTool(
    "structure_leaps_position",
    {
      title: "Structure LEAPS position (paid)",
      description:
        "Paid per call. Full thesis-to-structure analysis: picks the best currently listed Deribit LEAPS call for the thesis, sizes it against capital, and returns strike, expiry, USD premium, contract count, breakeven, greeks, mark IV, bull/base/bear scenarios, entry notes, roll trigger and risk flags as strict JSON. Built only from real listed contracts. Analysis, not financial advice.",
      inputSchema: inputShape,
    },
    (args) => runTool(args, {})
  );

  return server;
}

// stateless handler: new transport + server per POST, plain JSON back.
export async function handleMcpRequest(req, res) {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = buildMcpServer();
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

// per-tool-call payment gating: only paid tool calls hit the x402 gate.
// initialize / tools/list / free-preview calls pass untouched so any agent
// can discover the service before paying.
export function isPaidMcpCall(body) {
  return body?.method === "tools/call" && body?.params?.name === "structure_leaps_position";
}
