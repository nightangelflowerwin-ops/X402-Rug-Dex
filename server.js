import express from "express";
import { paymentMiddleware } from "x402-express";
import { facilitator } from "@coinbase/x402";
import { detectClusters } from "./clustering.js";

const app = express();

// Basic request logging so failures are actually visible in Railway logs
app.use((req, res, next) => {
  console.log(`[req] ${req.method} ${req.url}`);
  next();
});

// --- x402 payment config ---
// Charges $0.05 USDC on Base per successful lookup.
// PAY_TO_ADDRESS should be the wallet you want proceeds sent to.
//
// Uses Coinbase's CDP facilitator, which is required for real (mainnet) Base
// settlement — the generic x402.org/facilitator only works on Base Sepolia
// testnet and will silently reject real mainnet payments.
// Requires CDP_API_KEY_ID and CDP_API_KEY_SECRET env vars (free, from
// portal.cdp.coinbase.com).
const PAY_TO_ADDRESS = process.env.PAY_TO_ADDRESS;

app.use(
  paymentMiddleware(
    PAY_TO_ADDRESS,
    {
      "GET /api/wallet-clusters": {
        price: "$0.05",
        network: "base",
        config: {
          description:
            "Detects likely wallet clusters (insiders/bundlers) holding a given Solana meme coin, based on shared funding sources and funding-time correlation.",
        },
      },
    },
    facilitator
  )
);

app.get("/api/wallet-clusters", async (req, res) => {
  const mint = req.query.mint;
  const topN = Math.min(Number(req.query.topN) || 50, 100);

  if (!mint) {
    return res.status(400).json({
      error: "mint parameter required",
      example: "/api/wallet-clusters?mint=<token_mint_address>&topN=50",
    });
  }

  try {
    const result = await detectClusters(mint, topN);
    res.json({ status: "success", data: result });
  } catch (err) {
    res.status(502).json({
      status: "error",
      error: err.message,
    });
  }
});

app.get("/", (req, res) => {
  res.json({
    service: "wallet-cluster-x402",
    description:
      "Paid API (x402) for detecting wallet clusters in Solana meme coins.",
    endpoint: "GET /api/wallet-clusters?mint=<mint>&topN=<n>",
    price: "$0.05 USDC on Base per call",
  });
});

const PORT = process.env.PORT || 3000;

// Catch anything that slips through unhandled, log it fully instead of silently 500ing
app.use((err, req, res, next) => {
  console.error("[unhandled error]", err?.message, err?.stack);
  res.status(500).json({ error: "internal error", message: err?.message });
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

app.listen(PORT, () => {
  console.log(`wallet-cluster-x402 listening on :${PORT}`);
  if (!PAY_TO_ADDRESS) {
    console.warn(
      "WARNING: PAY_TO_ADDRESS not set — payments have nowhere to settle."
    );
  }
  if (!process.env.HELIUS_API_KEY) {
    console.warn(
      "WARNING: HELIUS_API_KEY not set — /api/wallet-clusters will fail."
    );
  }
  if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET) {
    console.warn(
      "WARNING: CDP_API_KEY_ID / CDP_API_KEY_SECRET not set — payments will fail to verify on Base mainnet."
    );
  }
});
