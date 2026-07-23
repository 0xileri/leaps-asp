// end-to-end mock test: boots the server with MOCK=1 + PAYMENT_MODE=demo,
// then walks the exact flow a buyer agent would: preview -> 402 -> pay -> 200.
process.env.MOCK = "1";
process.env.PAYMENT_MODE = "demo";
process.env.PORT = "3999";

await import("../src/server.js");
await new Promise((r) => setTimeout(r, 300));

const BASE = "http://localhost:3999";
const body = JSON.stringify({
  asset: "BTC",
  thesis: "new ATH within 18 months driven by ETF inflows",
  horizon_months: 18,
  conviction: "high",
  capital_usd: 5000,
});
const H = { "content-type": "application/json" };

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
};

// 1. free preview
const prev = await fetch(`${BASE}/preview`, { method: "POST", headers: H, body });
const prevJson = await prev.json();
check("preview returns 200", prev.status === 200);
check("preview has instrument but no sizing", !!prevJson.recommended?.instrument && prevJson.recommended.contract_count === undefined);

// 2. paid endpoint without payment -> 402 with challenge
const unpaid = await fetch(`${BASE}/structure`, { method: "POST", headers: H, body });
const challenge = await unpaid.json();
check("unpaid /structure returns 402", unpaid.status === 402);
check("402 carries x402-shaped challenge", challenge.x402Version === 2 && Array.isArray(challenge.accepts));

// 3. retry with payment header -> full structure
const paid = await fetch(`${BASE}/structure`, { method: "POST", headers: { ...H, "X-PAYMENT": "demo" }, body });
const out = await paid.json();
check("paid /structure returns 200", paid.status === 200);
check("instrument is a real fixture contract", /^BTC-\d{1,2}[A-Z]{3}\d{2}-\d+-C$/.test(out.recommended?.instrument ?? ""));
check("premium converted to USD (> raw coin mark)", out.recommended?.est_premium_usd > 100);
check("breakeven = strike + premium", Math.abs(out.recommended.breakeven_usd - (out.recommended.strike_usd + out.recommended.est_premium_usd)) < 1);
check("3 scenarios present", out.scenarios?.length === 3);
check("18m request flags the horizon cap", out.risk_flags?.some((f) => f.includes("longest listed expiry")));
check("coin-settlement flag present", out.risk_flags?.some((f) => f.includes("coin-settled")));
check("disclaimer intact", out.disclaimer === "analysis only, not financial advice");
check("contract sizing respects capital", out.recommended.contract_count * out.recommended.est_premium_usd <= 5000 * 1.001);

// 4. validation rejects garbage
const bad = await fetch(`${BASE}/structure`, { method: "POST", headers: { ...H, "X-PAYMENT": "demo" }, body: JSON.stringify({ asset: "DOGE", capital_usd: -5 }) });
check("bad input returns 400", bad.status === 400);

// 5. SOL is explicitly rejected in v1 (linear USDC-settled — different quoting than BTC/ETH inverse)
const sol = await fetch(`${BASE}/structure`, { method: "POST", headers: { ...H, "X-PAYMENT": "demo" }, body: JSON.stringify({ asset: "SOL", capital_usd: 1000 }) });
const solJson = await sol.json();
check("SOL returns 400 with a clear reason", sol.status === 400 && solJson.errors?.[0]?.includes("USDC-settled"));


// ---------- A2MCP layer ----------
const MCPH = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const rpc = (id, method, params) => JSON.stringify({ jsonrpc: "2.0", id, method, params });

// 6. initialize handshake
const init = await fetch(`${BASE}/mcp`, { method: "POST", headers: MCPH, body: rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test-buyer-agent", version: "0.0.1" } }) });
const initJson = await init.json();
check("mcp initialize returns server info", init.status === 200 && initJson.result?.serverInfo?.name === "leaps-asp");

// 7. tool discovery
const list = await fetch(`${BASE}/mcp`, { method: "POST", headers: MCPH, body: rpc(2, "tools/list", {}) });
const listJson = await list.json();
const toolNames = (listJson.result?.tools ?? []).map((t) => t.name).sort();
check("mcp lists both tools", JSON.stringify(toolNames) === JSON.stringify(["preview_leaps_structure", "structure_leaps_position"]));

// 8. free preview tool needs no payment
const args = { asset: "BTC", thesis: "new ATH in 18 months", horizon_months: 18, conviction: "high", capital_usd: 5000 };
const prevTool = await fetch(`${BASE}/mcp`, { method: "POST", headers: MCPH, body: rpc(3, "tools/call", { name: "preview_leaps_structure", arguments: args }) });
const prevToolJson = await prevTool.json();
const prevPayload = JSON.parse(prevToolJson.result?.content?.[0]?.text ?? "{}");
check("mcp free preview works without payment", prevTool.status === 200 && !!prevPayload.recommended?.instrument && prevPayload.recommended.contract_count === undefined);

// 9. paid tool without payment -> 402 challenge at the HTTP layer
const paidNo = await fetch(`${BASE}/mcp`, { method: "POST", headers: MCPH, body: rpc(4, "tools/call", { name: "structure_leaps_position", arguments: args }) });
const paidNoJson = await paidNo.json();
check("mcp paid tool gated by 402", paidNo.status === 402 && paidNoJson.x402Version === 2);

// 10. paid tool with payment header -> full structure through MCP
const paidYes = await fetch(`${BASE}/mcp`, { method: "POST", headers: { ...MCPH, "X-PAYMENT": "demo" }, body: rpc(5, "tools/call", { name: "structure_leaps_position", arguments: args }) });
const paidYesJson = await paidYes.json();
const fullPayload = JSON.parse(paidYesJson.result?.content?.[0]?.text ?? "{}");
check("mcp paid tool returns full structure", paidYes.status === 200 && /^BTC-/.test(fullPayload.recommended?.instrument ?? "") && fullPayload.scenarios?.length === 3 && fullPayload.recommended.contract_count > 0);
check("mcp paid output flags horizon cap + settlement", fullPayload.risk_flags?.length >= 2);

// 11. bad args through MCP come back as a tool error, not a crash
const badTool = await fetch(`${BASE}/mcp`, { method: "POST", headers: MCPH, body: rpc(6, "tools/call", { name: "preview_leaps_structure", arguments: { asset: "SOL", capital_usd: 100 } }) });
const badToolJson = await badTool.json();
check("mcp rejects SOL cleanly", badTool.status === 200 && (badToolJson.result?.isError === true || JSON.stringify(badToolJson).includes("USDC-settled")));

console.log("\nsample paid response:\n" + JSON.stringify(out, null, 2));
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);