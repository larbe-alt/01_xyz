/**
 * Throughput benchmark for the backtest engine.
 *
 * Generates synthetic events (snapshots, deltas, trades) and runs them through
 * the full runBacktest() pipeline. Reports events/sec, CPU time, and memory.
 *
 * Usage: tsx src/scripts/bench-backtest.ts [eventCount] [bookDepth]
 */
import { performance } from "node:perf_hooks";
import { Side } from "@n1xyz/nord-ts";
import { runBacktest, type BacktestEvent } from "../backtest/runner.js";
import type { BacktestConfig } from "../backtest/config.js";
import type { Strategy, StrategyContext, FeedTrade } from "../engine/types.js";
import type { Native01Event } from "../sim/sources/native01.js";
import type { LocalBook } from "../data/feed.js";

const EVENT_COUNT = Number(process.argv[2]) || 500_000;
const BOOK_DEPTH = Number(process.argv[3]) || 50;

function generateEvents(n: number, depth: number): BacktestEvent[] {
  const events: BacktestEvent[] = [];
  const basePrice = 2000;
  const tickSize = 0.01;
  let ts = 1_700_000_000_000;

  // Initial snapshot
  const bids: [number, number][] = [];
  const asks: [number, number][] = [];
  for (let i = 0; i < depth; i++) {
    bids.push([basePrice - (i + 1) * tickSize, 10 + Math.random() * 90]);
    asks.push([basePrice + (i + 1) * tickSize, 10 + Math.random() * 90]);
  }
  events.push({ symbol: "ETHUSD", marketId: 1, event: { kind: "snapshot", ts, bids, asks } });
  ts += 100;

  // Mix of deltas (~70%) and trades (~30%)
  for (let i = 1; i < n; i++) {
    ts += 1 + Math.floor(Math.random() * 10);
    if (Math.random() < 0.7) {
      // Delta: update 1-3 levels
      const dBids: [number, number][] = [];
      const dAsks: [number, number][] = [];
      const nLevels = 1 + Math.floor(Math.random() * 3);
      for (let j = 0; j < nLevels; j++) {
        const offset = 1 + Math.floor(Math.random() * depth);
        const newSize = Math.random() < 0.15 ? 0 : 5 + Math.random() * 50;
        if (Math.random() < 0.5) {
          dBids.push([basePrice - offset * tickSize, newSize]);
        } else {
          dAsks.push([basePrice + offset * tickSize, newSize]);
        }
      }
      const ev: Native01Event = { kind: "delta", ts, bids: dBids, asks: dAsks };
      events.push({ symbol: "ETHUSD", marketId: 1, event: ev });
    } else {
      // Trade
      const side = Math.random() < 0.5 ? "bid" : "ask";
      const price = side === "bid"
        ? basePrice + (1 + Math.floor(Math.random() * 3)) * tickSize
        : basePrice - (1 + Math.floor(Math.random() * 3)) * tickSize;
      const ev: Native01Event = {
        kind: "trade",
        ts,
        trade: { side: side as "bid" | "ask", price, size: 0.1 + Math.random() * 2, ts },
      };
      events.push({ symbol: "ETHUSD", marketId: 1, event: ev });
    }
  }
  return events;
}

// Strategy that places occasional taker orders to exercise the full path
let tradesSeen = 0;
const benchStrategy: Strategy = {
  name: "bench",
  async init() {},
  onBook(_b: LocalBook) {},
  async onTrade(_t: FeedTrade, ctx: StrategyContext) {
    tradesSeen++;
    if (tradesSeen % 500 === 0) {
      await ctx.orders.place({ symbol: "ETHUSD", side: Side.Bid, type: "market", size: 0.01 });
    }
    if (tradesSeen % 1000 === 0) {
      await ctx.orders.place({ symbol: "ETHUSD", side: Side.Ask, type: "market", size: 0.01, reduceOnly: true });
    }
  },
};

const config: BacktestConfig = {
  strategy: "bench",
  markets: [{ symbol: "ETHUSD", marketId: 1 }],
  data: { dir: "data", env: "bench" },
  risk: { defaultMaxLeverage: 20, maxAccountAgeSec: 999 },
  initialEquity: 100_000,
  fees: { makerBps: 1, takerBps: 3.5 },
  curveIntervalMs: 100,
  tickMs: 60_000,
};

console.log(`Generating ${EVENT_COUNT.toLocaleString()} events (${BOOK_DEPTH} depth levels)...`);
const events = generateEvents(EVENT_COUNT, BOOK_DEPTH);
const trades = events.filter((e) => e.event.kind === "trade").length;
const deltas = events.filter((e) => e.event.kind === "delta").length;
console.log(`  snapshots: 1, deltas: ${deltas.toLocaleString()}, trades: ${trades.toLocaleString()}`);

const memBefore = process.memoryUsage();
const cpuBefore = process.cpuUsage();
const t0 = performance.now();

const report = await runBacktest(config, events, benchStrategy);

const elapsed = performance.now() - t0;
const cpuAfter = process.cpuUsage(cpuBefore);
const memAfter = process.memoryUsage();

const evPerSec = Math.round(EVENT_COUNT / (elapsed / 1000));
const cpuMs = (cpuAfter.user + cpuAfter.system) / 1000;

console.log(`\n── Throughput ──`);
console.log(`  Wall time:  ${(elapsed / 1000).toFixed(2)}s`);
console.log(`  CPU time:   ${(cpuMs / 1000).toFixed(2)}s (user: ${(cpuAfter.user / 1e6).toFixed(2)}s, sys: ${(cpuAfter.system / 1e6).toFixed(2)}s)`);
console.log(`  Events/sec: ${evPerSec.toLocaleString()}`);
console.log(`  Trades/sec: ${Math.round(trades / (elapsed / 1000)).toLocaleString()}`);

console.log(`\n── Memory ──`);
console.log(`  Heap used:  ${((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(1)} MB delta (${(memAfter.heapUsed / 1024 / 1024).toFixed(1)} MB total)`);
console.log(`  RSS:        ${(memAfter.rss / 1024 / 1024).toFixed(1)} MB`);

console.log(`\n── Results ──`);
console.log(`  Equity curve samples: ${report.aggregate.durationMs > 0 ? "yes" : "no"}`);
console.log(`  Total trades:  ${report.aggregate.totalTrades}`);
console.log(`  Total return:  ${(report.aggregate.totalReturn * 100).toFixed(4)}%`);
console.log(`  Total fees:    $${report.aggregate.totalFees.toFixed(2)}`);
