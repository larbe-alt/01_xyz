/**
 * Latency benchmark — mainnet real round-trip times
 *
 * Measures:
 *   1. WS+client init (Nord.new + syncTime)
 *   2. REST: getInfo, getMarketsLive, getOrderbook
 *   3. User init (updateAccountId + refreshSession + fetchInfo)
 *   4. Place post-only limit order (far from market, no fill risk)
 *   5. Cancel order
 *   6. Full place→cancel round-trip
 *
 * Usage:
 *   NETWORK=mainnet tsx src/scripts/bench-latency.ts [--n 5] [--symbol ETHUSD]
 */

import "../utils/polyfills.js";
import { Nord, NordUser, Side, FillMode } from "@n1xyz/nord-ts";
import { Connection } from "@solana/web3.js";
import { loadConfig } from "../config.js";
import { syncTime } from "../utils/time.js";
import { initMarkets, bySymbol, marketRoundPrice, marketRoundSize } from "../registry/markets.js";
import { initTokens } from "../registry/tokens.js";

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag: string, def: string) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const N = parseInt(getArg("--n", "5"), 10);
const SYMBOL = getArg("--symbol", "ETHUSD");

// ── helpers ──────────────────────────────────────────────────────────────────

function now() { return performance.now(); }

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const p = (pct: number) => s[Math.max(0, Math.floor(s.length * pct / 100) - 1)] ?? s[0];
  return {
    min: s[0],
    p50: p(50),
    p95: p(95),
    max: s[s.length - 1],
    avg: s.reduce((a, b) => a + b, 0) / s.length,
    n: s.length,
  };
}

function fmtMs(ms: number) { return `${ms.toFixed(1)}ms`; }

function printStats(label: string, samples: number[]) {
  const s = stats(samples);
  const col = (v: number) => fmtMs(v).padStart(8);
  console.log(
    `  ${label.padEnd(30)} n=${s.n}  avg=${col(s.avg)}  p50=${col(s.p50)}  p95=${col(s.p95)}  min=${col(s.min)}  max=${col(s.max)}`
  );
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = now();
  const r = await fn();
  return [r, now() - t0];
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = loadConfig();
  if (cfg.network !== "mainnet") {
    console.warn(`⚠  NETWORK=${cfg.network} — latency numbers won't reflect mainnet. Set NETWORK=mainnet for real data.\n`);
  }

  console.log(`\n=== 01 Exchange Latency Benchmark ===`);
  console.log(`Network: ${cfg.network}  |  Symbol: ${SYMBOL}  |  Iterations: ${N}\n`);

  // ── 1. WS + client init ──────────────────────────────────────────────────
  console.log("[ 1 ] Client / WS init ...");
  const [nord, initMs] = await timed(async () => {
    const conn = new Connection(cfg.solanaRpc);
    const n = await Nord.new({ app: cfg.appKey, solanaConnection: conn, webServerUrl: cfg.webServerUrl });
    await syncTime(n);
    return n;
  });
  console.log(`  Nord.new + syncTime            ${fmtMs(initMs)}`);

  await initMarkets(nord);
  await initTokens(nord);

  // ── 2. REST endpoints ────────────────────────────────────────────────────
  console.log("\n[ 2 ] REST latency ...");

  const getInfoSamples: number[] = [];
  const getLiveSamples: number[] = [];
  const getObSamples: number[] = [];

  for (let i = 0; i < N; i++) {
    const [, dt] = await timed(() => nord.getInfo());
    getInfoSamples.push(dt);
  }

  for (let i = 0; i < N; i++) {
    const [, dt] = await timed(() => nord.getMarketsLive());
    getLiveSamples.push(dt);
  }

  for (let i = 0; i < N; i++) {
    const [, dt] = await timed(() => nord.getOrderbook({ symbol: SYMBOL }));
    getObSamples.push(dt);
  }

  printStats("getInfo", getInfoSamples);
  printStats("getMarketsLive", getLiveSamples);
  printStats(`getOrderbook(${SYMBOL})`, getObSamples);

  // ── 3. User / auth init ──────────────────────────────────────────────────
  if (!cfg.privateKey) {
    console.log("\n⚠  PRIVATE_KEY not set — skipping order latency tests\n");
    process.exit(0);
  }

  console.log("\n[ 3 ] User init ...");
  const [user, userInitMs] = await timed(async () => {
    const u = NordUser.fromPrivateKey(nord, cfg.privateKey!);
    await u.updateAccountId();
    await u.refreshSession();
    await u.fetchInfo();
    return u;
  });
  console.log(`  NordUser init                  ${fmtMs(userInitMs)}`);

  // ── 4. Get current market to set a safe price ───────────────────────────
  const meta = bySymbol(SYMBOL);
  const live = await nord.getMarketsLive();
  const mktLive = live.markets.find((m: any) => m.marketId === meta.marketId);
  const markPrice: number = mktLive?.perpetuals?.markPrice ?? mktLive?.indexPrice ?? 0;
  if (markPrice === 0) throw new Error(`Could not determine mark price for ${SYMBOL}`);

  // post-only far below bid (2%) — won't fill, won't be close enough to reject
  const safePrice = marketRoundPrice(SYMBOL, markPrice * 0.98);
  const minSize = marketRoundSize(SYMBOL, meta.sizeDecimals > 0 ? Math.pow(10, -meta.sizeDecimals) : 0.001);

  console.log(`\n  Mark price: ${markPrice}  Safe order price: ${safePrice}  Size: ${minSize}`);

  // ── 5. Place / cancel latency ─────────────────────────────────────────────
  console.log(`\n[ 4 ] Order latency (${N} place+cancel pairs) ...\n`);

  const placeSamples: number[] = [];
  const cancelSamples: number[] = [];
  const rtSamples: number[] = [];

  const accountId = (user.accountIds ?? [])[0];

  for (let i = 0; i < N; i++) {
    // place
    const t0 = now();
    const placed = await user.placeOrder({
      marketId: meta.marketId,
      side: Side.Bid,
      fillMode: FillMode.PostOnly,
      price: safePrice,
      size: minSize,
      isReduceOnly: false,
      clientOrderId: BigInt(Date.now()) * 1_000_000n + BigInt(i),
      accountId,
    });
    const placeMs = now() - t0;
    placeSamples.push(placeMs);

    const orderId = placed.orderId;
    if (!orderId) {
      console.warn(`  [${i}] No orderId returned — skipping cancel`);
      rtSamples.push(placeMs);
      continue;
    }

    // cancel
    const t1 = now();
    await user.cancelOrder(orderId, accountId);
    const cancelMs = now() - t1;
    cancelSamples.push(cancelMs);
    rtSamples.push(placeMs + cancelMs);

    process.stdout.write(`  [${i + 1}/${N}] place=${fmtMs(placeMs)}  cancel=${fmtMs(cancelMs)}  rt=${fmtMs(placeMs + cancelMs)}\n`);

    // small gap to avoid rate-limit
    await new Promise(r => setTimeout(r, 100));
  }

  // ── Results ───────────────────────────────────────────────────────────────
  console.log(`\n=== Summary ===\n`);
  console.log(`  ${"Metric".padEnd(30)} ${"n".padEnd(4)}  ${"avg".padStart(8)}  ${"p50".padStart(8)}  ${"p95".padStart(8)}  ${"min".padStart(8)}  ${"max".padStart(8)}`);
  console.log(`  ${"-".repeat(80)}`);

  printStats("getInfo (REST)", getInfoSamples);
  printStats("getMarketsLive (REST)", getLiveSamples);
  printStats(`getOrderbook (REST)`, getObSamples);
  if (placeSamples.length)  printStats("placeOrder (WS RPC)", placeSamples);
  if (cancelSamples.length) printStats("cancelOrder (WS RPC)", cancelSamples);
  if (rtSamples.length)     printStats("place+cancel round-trip", rtSamples);

  console.log();
}

main().catch(err => {
  console.error("bench-latency failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
