import express from "express";
import { paymentMiddleware } from "x402-express";
import { detectClusters } from "./clustering.js";

const app = express();

// --- x402 payment config ---
// Charges $0.05 USDC on Base per successful lookup.
// PAY_TO_ADDRESS should be the wallet you want proceeds sent to.
const PAY_TO_ADDRESS = process.env.PAY_TO_ADDRESS;
const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator";

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
    { url: FACILITATOR_URL }
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
});
