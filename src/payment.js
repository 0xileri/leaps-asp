// x402 payment gate for the paid surfaces (POST /structure, paid MCP tool calls).
//
// live mode uses OKX's seller SDK (@okxweb3/x402-express + x402-core + x402-evm):
// the middleware answers unpaid requests with a 402 x402 challenge, and on a
// retry carrying the payment header it verifies + settles through the OKX
// facilitator (SA API, HMAC-signed) before letting the request through.
// settlement lands on X Layer (USDT0) at the PAY_TO_ADDRESS wallet.
//
// modes:
//   PAYMENT_MODE=off    -> endpoint is open (local dev)
//   PAYMENT_MODE=demo   -> replies 402 with a mock x402-shaped challenge unless the
//                          caller sends X-PAYMENT (any value). proves the flow shape
//                          end-to-end for testing. NOT real payment verification.
//   PAYMENT_MODE=live   -> real OKX facilitator verification. requires:
//                          OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE  (OKX developer
//                          platform facilitator credentials), PAY_TO_ADDRESS (receiving
//                          wallet on X Layer). optional: X402_NETWORK (default
//                          eip155:196 = X Layer mainnet; eip155:1952 = testnet),
//                          OKX_BASE_URL, PRICE_USD.

const PRICE_USD = process.env.PRICE_USD || "0.30";
const PAY_TO = process.env.PAY_TO_ADDRESS || "0xYOUR_AGENTIC_WALLET";

let liveMwPromise = null;

async function buildLiveMiddleware() {
  const missing = ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE", "PAY_TO_ADDRESS"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    throw new Error(`PAYMENT_MODE=live but missing env vars: ${missing.join(", ")}`);
  }

  const [
    { OKXFacilitatorClient },
    { paymentMiddlewareFromHTTPServer, x402ResourceServer, x402HTTPResourceServer },
    { ExactEvmScheme },
  ] = await Promise.all([
    import("@okxweb3/x402-core"),
    import("@okxweb3/x402-express"),
    import("@okxweb3/x402-evm/exact/server"),
  ]);

  const network = process.env.X402_NETWORK || "eip155:196"; // X Layer mainnet
  const facilitator = new OKXFacilitatorClient({
    apiKey: process.env.OKX_API_KEY,
    secretKey: process.env.OKX_SECRET_KEY,
    passphrase: process.env.OKX_PASSPHRASE,
    baseUrl: process.env.OKX_BASE_URL ?? "https://web3.okx.com",
  });
  const resourceServer = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());

  const accepts = { scheme: "exact", network, payTo: process.env.PAY_TO_ADDRESS, price: `$${PRICE_USD}` };
  const routes = {
    // the /mcp entry is only ever reached for paid tool calls: server.js invokes
    // this gate conditionally (isPaidMcpCall), so discovery + free preview never
    // see a 402 even though the route is listed here.
    "POST /structure": { accepts, description: "LEAPS thesis-to-structure analysis, per call", mimeType: "application/json" },
    "POST /mcp": { accepts, description: "structure_leaps_position MCP tool call, per call", mimeType: "application/json" },
  };

  // initialization is managed here, not by the SDK: with syncFacilitatorOnStart
  // left on, the SDK fires httpServer.initialize() at build time with no rejection
  // handler, and an unreachable facilitator at boot crashes the whole process as
  // an unhandled rejection. with it off, the SDK never initializes at all. so:
  // flag off, and ensureFacilitator() awaits/retries initialize() per request.
  const httpServer = new x402HTTPResourceServer(resourceServer, routes);
  const mw = paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false);

  let initialized = false;
  let inflight = null;
  async function ensureFacilitator() {
    if (initialized) return;
    if (!inflight) {
      inflight = httpServer.initialize().then(
        () => {
          initialized = true;
        },
        (e) => {
          inflight = null; // retry on the next request
          throw e;
        }
      );
    }
    await inflight;
  }

  return async (req, res, next) => {
    await ensureFacilitator();
    return mw(req, res, next);
  };
}

// prebuild at boot (server.js calls this when PAYMENT_MODE=live) so credential
// problems surface at startup, not on the first paying customer.
export function initPayments() {
  if ((process.env.PAYMENT_MODE || "off") !== "live") return Promise.resolve();
  if (!liveMwPromise) liveMwPromise = buildLiveMiddleware();
  return liveMwPromise;
}

export function paymentGate(req, res, next) {
  const mode = process.env.PAYMENT_MODE || "off";

  if (mode === "off") return next();

  if (mode === "demo") {
    if (req.get("X-PAYMENT")) return next(); // no verification — demo shape only
    return res.status(402).json({
      x402Version: 2,
      error: "payment required",
      accepts: [
        {
          scheme: "exact",
          network: "xlayer",
          asset: "USDT",
          maxAmountRequired: PRICE_USD,
          payTo: PAY_TO,
          resource: "/structure",
          description: "LEAPS thesis-to-structure analysis, per call",
        },
      ],
    });
  }

  if (mode === "live") {
    if (!liveMwPromise) liveMwPromise = buildLiveMiddleware();
    liveMwPromise
      .then((mw) => mw(req, res, next))
      .catch((e) => {
        console.error("x402 live gate error:", e.message);
        if (!res.headersSent) res.status(503).json({ error: `payment gate unavailable: ${e.message}` });
      });
    return;
  }

  return res.status(500).json({ error: `unknown PAYMENT_MODE ${mode}` });
}
