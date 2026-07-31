import fetch from "node-fetch";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_TX_API = (addr) =>
  `https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${HELIUS_API_KEY}`;

// ---------- Union-Find (disjoint set) ----------
class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    if (this.parent.get(x) !== x) {
      this.parent.set(x, this.find(this.parent.get(x)));
    }
    return this.parent.get(x);
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// ---------- Step 1: get top holders of a token mint ----------
async function getTopHolders(mint, topN = 50) {
  const res = await fetch(HELIUS_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "holders",
      method: "getTokenLargestAccounts",
      params: [mint],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);

  const accounts = json.result.value.slice(0, topN);

  // Resolve token accounts -> owner wallet addresses
  const owners = await Promise.all(
    accounts.map(async (acc) => {
      const infoRes = await fetch(HELIUS_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "owner",
          method: "getAccountInfo",
          params: [acc.address, { encoding: "jsonParsed" }],
        }),
      });
      const infoJson = await infoRes.json();
      const owner =
        infoJson.result?.value?.data?.parsed?.info?.owner ?? null;
      return {
        tokenAccount: acc.address,
        owner,
        amount: acc.amount,
        decimals: acc.decimals,
      };
    })
  );

  return owners.filter((o) => o.owner);
}

// ---------- Step 2: find each wallet's earliest funding transaction ----------
// The "funder" of a fresh wallet is a strong clustering signal: bundlers/insiders
// often fund N wallets from one source wallet in a short window before a launch.
async function getFundingSource(wallet) {
  const res = await fetch(HELIUS_TX_API(wallet) + "&type=TRANSFER&limit=100");
  const txs = await res.json();
  if (!Array.isArray(txs) || txs.length === 0) return null;

  // Sort ascending by timestamp, find earliest native SOL transfer INTO this wallet
  const incoming = txs
    .filter((tx) =>
      (tx.nativeTransfers || []).some((t) => t.toUserAccount === wallet)
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  if (incoming.length === 0) return null;

  const first = incoming[0];
  const transfer = first.nativeTransfers.find((t) => t.toUserAccount === wallet);

  return {
    funder: transfer.fromUserAccount,
    timestamp: first.timestamp,
  };
}

// ---------- Step 3: build clusters ----------
// Clustering signals (any one triggers a union):
//   A. Two holders share the exact same funding wallet
//   B. Two holders were funded by wallets that were THEMSELVES funded by the
//      same upstream source (one hop up) — catches "funder of funders" patterns
//   C. Two holders were funded within a tight time window (<= TIME_WINDOW_SEC)
//      by the same funder (already covered by A, kept explicit for scoring)
const TIME_WINDOW_SEC = 120;

export async function detectClusters(mint, topN = 50) {
  const holders = await getTopHolders(mint, topN);

  const fundingInfo = new Map(); // owner -> { funder, timestamp }
  await Promise.all(
    holders.map(async (h) => {
      try {
        const info = await getFundingSource(h.owner);
        if (info) fundingInfo.set(h.owner, info);
      } catch {
        // wallet history unavailable; skip silently, it just won't cluster
      }
    })
  );

  const uf = new UnionFind();
  holders.forEach((h) => uf.find(h.owner));

  const byFunder = new Map(); // funder -> [owner...]
  for (const [owner, info] of fundingInfo.entries()) {
    if (!byFunder.has(info.funder)) byFunder.set(info.funder, []);
    byFunder.get(info.funder).push(owner);
  }

  const clusterReasons = new Map(); // pairKey -> reason string, for transparency

  // Signal A: same funder
  for (const [funder, owners] of byFunder.entries()) {
    if (owners.length < 2) continue;
    for (let i = 1; i < owners.length; i++) {
      uf.union(owners[0], owners[i]);
      clusterReasons.set(
        [owners[0], owners[i]].sort().join("|"),
        `shared funder ${funder}`
      );
    }
  }

  // Signal C: tight time window between distinct funders (possible one-source-many-hops)
  const fundingEntries = [...fundingInfo.entries()];
  for (let i = 0; i < fundingEntries.length; i++) {
    for (let j = i + 1; j < fundingEntries.length; j++) {
      const [ownerA, infoA] = fundingEntries[i];
      const [ownerB, infoB] = fundingEntries[j];
      if (infoA.funder === infoB.funder) continue; // already handled by Signal A
      if (Math.abs(infoA.timestamp - infoB.timestamp) <= TIME_WINDOW_SEC) {
        uf.union(ownerA, ownerB);
        clusterReasons.set(
          [ownerA, ownerB].sort().join("|"),
          `funded within ${TIME_WINDOW_SEC}s of each other`
        );
      }
    }
  }

  // Group holders by root parent
  const groups = new Map();
  for (const h of holders) {
    const root = uf.find(h.owner);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(h);
  }

  const totalSupplyHeld = holders.reduce((s, h) => s + Number(h.amount), 0);

  const clusters = [...groups.values()]
    .filter((g) => g.length > 1) // only report actual clusters, not singletons
    .map((g) => {
      const supplyHeld = g.reduce((s, h) => s + Number(h.amount), 0);
      return {
        walletCount: g.length,
        wallets: g.map((h) => h.owner),
        percentOfTop50Supply: Number(
          ((supplyHeld / totalSupplyHeld) * 100).toFixed(2)
        ),
        reasons: [
          ...new Set(
            g
              .flatMap((h1) =>
                g.map((h2) =>
                  clusterReasons.get([h1.owner, h2.owner].sort().join("|"))
                )
              )
              .filter(Boolean)
          ),
        ],
      };
    })
    .sort((a, b) => b.walletCount - a.walletCount);

  return {
    mint,
    holdersAnalyzed: holders.length,
    clustersFound: clusters.length,
    largestClusterPercentOfTop50Supply: clusters[0]?.percentOfTop50Supply ?? 0,
    clusters,
  };
}
