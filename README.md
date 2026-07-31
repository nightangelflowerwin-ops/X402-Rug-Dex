# wallet-cluster-x402

A pay-per-call x402 API that detects likely **wallet clusters** — groups of
wallets that are probably controlled by the same person/bot — holding a given
Solana meme coin. This is the kind of signal traders use to spot insider
bundles, sniper groups, or a team quietly holding a big chunk of "distributed"
supply before a launch.

## How it works

1. **Fetch top holders** of the token mint via Solana RPC
   (`getTokenLargestAccounts`), resolving token accounts to owner wallets.
2. **Trace each wallet's funding source** — the wallet that sent it its first
   SOL. Fresh wallets created just before a launch and funded from the same
   source are a classic bundler/insider pattern.
3. **Cluster wallets** with a union-find structure using two signals:
   - **Signal A — shared funder**: two holder wallets funded by the exact
     same source wallet.
   - **Signal B — tight funding-time correlation**: two holder wallets funded
     within a short window of each other (default 120s), even from different
     immediate funders — catches multi-hop funding fan-out.
4. **Score clusters** by wallet count and % of the analyzed supply they hold.

## Setup

```bash
npm install
export HELIUS_API_KEY=your_helius_key       # solana RPC + tx history provider
export PAY_TO_ADDRESS=0xYourBaseWalletAddr  # where x402 payments settle
export X402_FACILITATOR_URL=https://x402.org/facilitator  # or your own
npm start
```

## Usage

```
GET /api/wallet-clusters?mint=<token_mint_address>&topN=50
```

Costs **$0.05 USDC on Base** per call (configurable in `server.js`), paid via
the x402 protocol — any x402-compatible client (including a Paybox-connected
agent) can call this directly.

### Example response

```json
{
  "status": "success",
  "data": {
    "mint": "<mint address>",
    "holdersAnalyzed": 50,
    "clustersFound": 2,
    "largestClusterPercentOfTop50Supply": 34.5,
    "clusters": [
      {
        "walletCount": 6,
        "wallets": ["...", "..."],
        "percentOfTop50Supply": 34.5,
        "reasons": ["shared funder <addr>", "funded within 120s of each other"]
      }
    ]
  }
}
```

## Honest limitations (read before trusting the output)

- **Heuristic, not proof.** Shared funding source is *correlational*, not
  definitive — exchanges, launchpads, and airdrop distributors legitimately
  fund many unrelated wallets from one address. This will produce false
  positives around any wallet funded via a CEX withdrawal address, for
  example.
- **Only catches funding-based clustering.** It won't detect clusters that
  fund wallets from many different sources deliberately to evade this exact
  heuristic — a sufficiently careful actor can defeat this.
- **Only analyzes the current top-N holders.** Wallets that already sold out
  of their position won't appear, even if they were part of an insider
  cluster earlier.
- **Rate/cost consideration**: for `topN=50`, this makes on the order of
  ~100+ Helius API calls per request (holder resolution + funding lookup per
  wallet), so latency and Helius usage costs scale roughly linearly with
  `topN`. Consider caching by mint address for some TTL if this sees real
  traffic.
- Treat this as **one input among several** (LP lock status, dev wallet
  behavior, socials, contract audit) — not a standalone rug/scam verdict.
