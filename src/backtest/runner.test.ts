import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Side } from "@n1xyz/nord-ts";
import { runBacktest, type BacktestEvent } from "./runner.js";
import type { BacktestConfig } from "./config.js";
import type { Strategy, StrategyContext, FeedTrade } from "../engine/types.js";
import type { Native01Event } from "../sim/sources/native01.js";
import type { LocalBook } from "../data/feed.js";

function mkConfig(overrides?: Partial<BacktestConfig>): BacktestConfig {
  return {
    strategy: "test",
    markets: [{ symbol: "TESTUSD", marketId: 1 }],
    data: { dir: "data", env: "test" },
    risk: { defaultMaxLeverage: 20, maxAccountAgeSec: 999 },
    initialEquity: 10_000,
    ...overrides,
  };
}

function mkEvents(items: Native01Event[]): BacktestEvent[] {
  return items.map((e) => ({ symbol: "TESTUSD", marketId: 1, event: e }));
}

// ── Core event processing ───────────────────────────────────────────────────

describe("runBacktest", () => {
  it("noop strategy: processes events, returns zero-trade report", async () => {
    const noop: Strategy = { name: "noop", async init() {} };
    const events = mkEvents([
      { kind: "snapshot", ts: 1000, bids: [[100, 10]], asks: [[101, 10]] },
      { kind: "trade", ts: 2000, trade: { side: "ask", price: 100, size: 1, ts: 2000 } },
      { kind: "trade", ts: 3000, trade: { side: "bid", price: 101, size: 1, ts: 3000 } },
    ]);

    const report = await runBacktest(mkConfig(), events, noop);
    assert.equal(report.aggregate.totalTrades, 0);
    assert.equal(report.aggregate.totalReturn, 0);
  });

  it("tracks PnL when strategy places taker orders", async () => {
    let tradeCount = 0;
    const buyer: Strategy = {
      name: "buyer",
      async init() {},
      async onTrade(_t: FeedTrade, ctx: StrategyContext) {
        tradeCount++;
        if (tradeCount === 1) {
          await ctx.orders.place({ symbol: "TESTUSD", side: Side.Bid, type: "market", size: 1 });
        } else if (tradeCount === 2) {
          await ctx.orders.place({ symbol: "TESTUSD", side: Side.Ask, type: "market", size: 1, reduceOnly: true });
        }
      },
    };

    const events = mkEvents([
      { kind: "snapshot", ts: 1000, bids: [[100, 10]], asks: [[101, 10]] },
      { kind: "trade", ts: 2000, trade: { side: "ask", price: 100, size: 1, ts: 2000 } },
      { kind: "delta", ts: 2500, bids: [[100, 0], [105, 10]], asks: [[101, 0], [106, 10]] },
      { kind: "trade", ts: 3000, trade: { side: "bid", price: 106, size: 1, ts: 3000 } },
    ]);

    const report = await runBacktest(mkConfig(), events, buyer);
    assert.equal(report.aggregate.totalTrades, 2);
    assert.ok(report.aggregate.totalReturn > 0);
    assert.ok(report.aggregate.totalFees > 0);
  });

  it("fires onBook on snapshot and delta", async () => {
    const bookEvents: string[] = [];
    const bookWatcher: Strategy = {
      name: "book-watcher",
      async init() {},
      onBook(book: LocalBook) {
        bookEvents.push(`${book.symbol}:${book.bestBid}/${book.bestAsk}`);
      },
    };

    const events = mkEvents([
      { kind: "snapshot", ts: 1000, bids: [[100, 10]], asks: [[101, 10]] },
      { kind: "delta", ts: 1500, bids: [[100, 0], [102, 5]], asks: [] },
    ]);

    await runBacktest(mkConfig(), events, bookWatcher);
    assert.equal(bookEvents.length, 2);
    assert.equal(bookEvents[0], "TESTUSD:100/101");
    assert.equal(bookEvents[1], "TESTUSD:102/101");
  });

  it("fires virtual onTick at configured cadence", async () => {
    const tickTimes: number[] = [];
    const ticker: Strategy = {
      name: "ticker",
      async init() {},
      onTick(ctx: StrategyContext) {
        tickTimes.push(ctx.clock.now());
      },
    };

    const events = mkEvents([
      { kind: "snapshot", ts: 1000, bids: [[100, 10]], asks: [[101, 10]] },
      { kind: "trade", ts: 5500, trade: { side: "ask", price: 100, size: 1, ts: 5500 } },
    ]);

    await runBacktest(mkConfig({ tickMs: 1000 }), events, ticker);
    assert.ok(tickTimes.length >= 3);
    assert.equal(tickTimes[0], 5500);
    assert.equal(tickTimes[1], 5500);
    assert.equal(tickTimes[2], 5500);
  });

  it("clock returns virtual time, not wall-clock", async () => {
    let capturedTs = 0;
    const spy: Strategy = {
      name: "clock-spy",
      async init() {},
      onTrade(_t: FeedTrade, ctx: StrategyContext) {
        capturedTs = ctx.clock.now();
      },
    };

    const events = mkEvents([
      { kind: "snapshot", ts: 1000, bids: [[100, 10]], asks: [[101, 10]] },
      { kind: "trade", ts: 42_000, trade: { side: "ask", price: 100, size: 1, ts: 42_000 } },
    ]);

    await runBacktest(mkConfig(), events, spy);
    assert.equal(capturedTs, 42_000);
  });

  it("calls strategy.shutdown after events", async () => {
    let shutdownCalled = false;
    const strat: Strategy = {
      name: "shutdown-test",
      async init() {},
      shutdown() { shutdownCalled = true; },
    };

    const events = mkEvents([
      { kind: "snapshot", ts: 1000, bids: [[100, 10]], asks: [[101, 10]] },
    ]);

    await runBacktest(mkConfig(), events, strat);
    assert.ok(shutdownCalled);
  });

  it("continues when a strategy hook throws", async () => {
    let callCount = 0;
    const crasher: Strategy = {
      name: "crasher",
      async init() {},
      onTrade() {
        callCount++;
        if (callCount === 1) throw new Error("boom");
      },
    };

    const events = mkEvents([
      { kind: "snapshot", ts: 1000, bids: [[100, 10]], asks: [[101, 10]] },
      { kind: "trade", ts: 2000, trade: { side: "ask", price: 100, size: 1, ts: 2000 } },
      { kind: "trade", ts: 3000, trade: { side: "bid", price: 101, size: 1, ts: 3000 } },
    ]);

    const report = await runBacktest(mkConfig(), events, crasher);
    assert.equal(callCount, 2);
    assert.ok(report.aggregate);
  });

  it("handles multi-market backtest with per-symbol breakdown", async () => {
    const config = mkConfig({
      markets: [
        { symbol: "ETHUSD", marketId: 1 },
        { symbol: "BTCUSD", marketId: 2 },
      ],
    });

    let ethBought = false;
    let btcBought = false;
    const mm: Strategy = {
      name: "multi",
      async init() {},
      async onTrade(t: FeedTrade, ctx: StrategyContext) {
        if (t.symbol === "ETHUSD" && !ethBought) {
          ethBought = true;
          await ctx.orders.place({ symbol: "ETHUSD", side: Side.Bid, type: "market", size: 0.5 });
        }
        if (t.symbol === "BTCUSD" && !btcBought) {
          btcBought = true;
          await ctx.orders.place({ symbol: "BTCUSD", side: Side.Bid, type: "market", size: 0.01 });
        }
      },
    };

    const events: BacktestEvent[] = [
      { symbol: "ETHUSD", marketId: 1, event: { kind: "snapshot", ts: 1000, bids: [[1800, 10]], asks: [[1801, 10]] } },
      { symbol: "BTCUSD", marketId: 2, event: { kind: "snapshot", ts: 1000, bids: [[65000, 1]], asks: [[65100, 1]] } },
      { symbol: "ETHUSD", marketId: 1, event: { kind: "trade", ts: 2000, trade: { side: "ask", price: 1800, size: 1, ts: 2000 } } },
      { symbol: "BTCUSD", marketId: 2, event: { kind: "trade", ts: 2500, trade: { side: "ask", price: 65000, size: 0.1, ts: 2500 } } },
    ];

    const report = await runBacktest(config, events, mm);
    assert.ok(report.perSymbol.length >= 1);
    assert.equal(report.aggregate.totalTrades, 2);
  });

  it("throws on empty events", async () => {
    const noop: Strategy = { name: "noop", async init() {} };
    await assert.rejects(() => runBacktest(mkConfig(), [], noop), /No events/);
  });
});
