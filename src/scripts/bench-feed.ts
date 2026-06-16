import "../utils/polyfills.js";
import { getNord, getConfig } from "../client.js";
import { initMarkets } from "../registry/markets.js";
import { initTokens } from "../registry/tokens.js";
import { LiveFeed } from "../data/feed.js";
import { createLogger } from "../utils/logger.js";
import { performance } from "node:perf_hooks";

const log = createLogger("bench-feed");
const SYMBOL = process.argv[2] || "BTCUSD";

function stats(samples: number[]): Record<string, unknown> {
  if (!samples.length) return { count: 0 };
  samples.sort((a, b) => a - b);
  return {
    count: samples.length,
    min: `${samples[0].toFixed(3)}ms`,
    median: `${samples[Math.floor(samples.length / 2)].toFixed(3)}ms`,
    p95: `${samples[Math.floor(samples.length * 0.95)].toFixed(3)}ms`,
    p99: `${samples[Math.floor(samples.length * 0.99)].toFixed(3)}ms`,
    max: `${samples[samples.length - 1].toFixed(3)}ms`,
    avg: `${(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(3)}ms`,
  };
}

async function main() {
  const cfg = getConfig();
  log.info("Feed benchmark", { network: cfg.network, symbol: SYMBOL });

  const nord = await getNord();
  await initMarkets(nord);
  await initTokens(nord);

  // --- Part 1: Live connection + book sync latency ---
  log.info("=== Part 1: Live connection timing ===");

  const feed = new LiveFeed(nord, {
    trades: [SYMBOL],
    deltas: [SYMBOL],
    candles: [{ symbol: SYMBOL, resolution: "1" }],
  });

  const connectStart = performance.now();
  let connectMs = 0;
  let syncMs = 0;
  const syncStart = performance.now();

  await new Promise<void>((resolve) => {
    feed.on("connected", () => {
      connectMs = performance.now() - connectStart;
    });
    feed.on("book", () => {
      syncMs = performance.now() - syncStart;
      resolve();
    });
    feed.start();
  });

  log.info("Connection", { connectMs: `${connectMs.toFixed(1)}ms` });
  log.info("Book sync (connect + REST snapshot + apply)", { syncMs: `${syncMs.toFixed(1)}ms` });

  // --- Part 2: Accessor benchmarks (O(1) cached reads) ---
  log.info("=== Part 2: Accessor latency (10,000 iterations) ===");

  const N = 10_000;
  const getMidTimes: number[] = [];
  const getSpreadTimes: number[] = [];
  const getBestBidTimes: number[] = [];
  const getBestAskTimes: number[] = [];
  const getBookTimes: number[] = [];
  const getBids3Times: number[] = [];
  const getAsks3Times: number[] = [];

  for (let i = 0; i < N; i++) {
    let t = performance.now(); feed.getMid(SYMBOL); getMidTimes.push(performance.now() - t);
    t = performance.now(); feed.getSpread(SYMBOL); getSpreadTimes.push(performance.now() - t);
    t = performance.now(); feed.getBestBid(SYMBOL); getBestBidTimes.push(performance.now() - t);
    t = performance.now(); feed.getBestAsk(SYMBOL); getBestAskTimes.push(performance.now() - t);
    t = performance.now(); feed.getBook(SYMBOL); getBookTimes.push(performance.now() - t);
    t = performance.now(); feed.getBids(SYMBOL, 3); getBids3Times.push(performance.now() - t);
    t = performance.now(); feed.getAsks(SYMBOL, 3); getAsks3Times.push(performance.now() - t);
  }

  log.info("getMid()", stats(getMidTimes));
  log.info("getSpread()", stats(getSpreadTimes));
  log.info("getBestBid()", stats(getBestBidTimes));
  log.info("getBestAsk()", stats(getBestAskTimes));
  log.info("getBook()", stats(getBookTimes));
  log.info("getBids(3)", stats(getBids3Times));
  log.info("getAsks(3)", stats(getAsks3Times));

  // --- Part 3: Synthetic delta apply benchmark ---
  log.info("=== Part 3: Synthetic delta apply (simulated throughput) ===");

  const book = feed.getBook(SYMBOL)!;
  const applyTimes: number[] = [];
  const fullCycleTimes: number[] = [];
  const DELTAS = 10_000;

  const baseBid = book.bestBid;
  const baseAsk = book.bestAsk;

  for (let i = 0; i < DELTAS; i++) {
    const fakeDelta = {
      market_symbol: SYMBOL,
      last_update_id: book.updateId,
      update_id: book.updateId + 1,
      bids: [[baseBid - (i % 5) * 10, i % 3 === 0 ? 0 : 0.001 * (i + 1)]] as [number, number][],
      asks: [[baseAsk + (i % 5) * 10, i % 3 === 0 ? 0 : 0.001 * (i + 1)]] as [number, number][],
    };

    // Measure just the apply (accessing internal via emit simulation)
    const t0 = performance.now();
    // apply directly: upsert + best-price tracking
    for (const [p, s] of fakeDelta.bids) {
      if (s === 0) { book.bids.delete(p); }
      else { book.bids.set(p, s); }
    }
    for (const [p, s] of fakeDelta.asks) {
      if (s === 0) { book.asks.delete(p); }
      else { book.asks.set(p, s); }
    }
    book.updateId = fakeDelta.update_id;
    const t1 = performance.now();
    applyTimes.push(t1 - t0);

    // Measure full cycle: apply + getMid + getSpread
    const t2 = performance.now();
    feed.getMid(SYMBOL);
    feed.getSpread(SYMBOL);
    feed.getBestBid(SYMBOL);
    feed.getBestAsk(SYMBOL);
    const t3 = performance.now();
    fullCycleTimes.push((t1 - t0) + (t3 - t2));
  }

  log.info("applyDelta (map upsert only)", stats(applyTimes));
  log.info("full cycle (apply + getMid + getSpread + bestBid + bestAsk)", stats(fullCycleTimes));

  const totalApplyMs = applyTimes.reduce((a, b) => a + b, 0);
  const totalCycleMs = fullCycleTimes.reduce((a, b) => a + b, 0);
  log.info("Throughput", {
    deltasPerSec: Math.round(DELTAS / (totalApplyMs / 1000)),
    fullCyclesPerSec: Math.round(DELTAS / (totalCycleMs / 1000)),
  });

  // --- Part 4: EventEmitter overhead ---
  log.info("=== Part 4: EventEmitter emit overhead ===");

  const emitTimes: number[] = [];
  let sink = 0;
  feed.on("_bench", () => { sink++; });
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    feed.emit("_bench");
    emitTimes.push(performance.now() - t);
  }
  log.info("emit('_bench')", { ...stats(emitTimes), sink });

  feed.close();
  log.info("Benchmark complete");
}

main().catch((err) => {
  log.error("Fatal", { error: err.message, stack: err.stack });
  process.exit(1);
});
