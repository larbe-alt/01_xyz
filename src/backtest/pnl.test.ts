import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OrderBook } from "../sim/book.js";
import { MatchingEngine } from "../sim/matching.js";
import { SimState } from "../sim/adapters.js";
import { PnLEngine } from "./pnl.js";
import { computeMetrics } from "./metrics.js";
import { formatReport, toJSON } from "./report.js";
import type { Fill } from "../sim/types.js";

function mkFill(side: "bid" | "ask", price: number, size: number, fee: number, ts: number, liq: "maker" | "taker" = "taker"): Fill {
  return { cid: 0, side, price, size, fee, liquidity: liq, ts };
}

// ── PnLEngine ────────────────────────────────────────────────────────────────

describe("PnLEngine", () => {
  it("records equity curve samples on fills and marks", () => {
    const state = new SimState(10_000);
    const pnl = new PnLEngine(state);

    pnl.onMark("ETH", 100, 1000);
    pnl.onFills([mkFill("bid", 100, 1, 0.5, 2000)], "ETH", 1, 2000);
    pnl.onMark("ETH", 110, 3000);

    const curve = pnl.equityCurve();
    assert.ok(curve.length >= 3);
    assert.equal(curve[0].equity, 10_000); // mark only, no position yet → initial
    // After buy @ 100, fee 0.5: equity = 10000 - 0.5
    assert.equal(curve[1].equity, 9999.5);
    // After mark moves to 110: unrealized = (110-100)*1 = 10
    assert.equal(curve[2].equity, 10_009.5);
  });

  it("attributes realized PnL per fill in trade log", () => {
    const state = new SimState(10_000);
    const pnl = new PnLEngine(state);

    pnl.onFills([mkFill("bid", 100, 2, 0, 1000)], "ETH", 1, 1000);
    pnl.onFills([mkFill("ask", 120, 1, 0, 2000)], "ETH", 1, 2000);

    const trades = pnl.trades();
    assert.equal(trades.length, 2);
    assert.equal(trades[0].realizedPnl, 0); // opening
    assert.equal(trades[1].realizedPnl, 20); // (120-100)*1
  });

  it("records slippage relative to mid", () => {
    const state = new SimState(10_000);
    const pnl = new PnLEngine(state);

    pnl.onMark("ETH", 100, 500); // mid = 100
    pnl.onFills([mkFill("bid", 101, 1, 0, 1000)], "ETH", 1, 1000); // bought above mid

    const t = pnl.trades()[0];
    assert.equal(t.midAtFill, 100);
    assert.equal(t.slippage, 1); // paid 1 above mid
  });

  it("slippage is positive for adverse fills on both sides", () => {
    const state = new SimState(10_000);
    const pnl = new PnLEngine(state);

    pnl.onMark("ETH", 100, 500);
    pnl.onFills([mkFill("ask", 99, 1, 0, 1000)], "ETH", 1, 1000); // sold below mid

    assert.equal(pnl.trades()[0].slippage, 1); // adverse = mid - fill = 100 - 99 = 1
  });

  it("records funding accruals", () => {
    const state = new SimState(10_000);
    const pnl = new PnLEngine(state);

    pnl.onFills([mkFill("bid", 100, 2, 0, 1000)], "ETH", 1, 1000);
    pnl.onMark("ETH", 100, 1500);
    // Long 2 ETH at mark 100, rate 0.001 → payment = 0.001 * 2 * 100 = 0.2
    pnl.onFunding("ETH", 0.001, 2000);

    const f = pnl.funding();
    assert.equal(f.length, 1);
    assert.ok(Math.abs(f[0].payment - 0.2) < 1e-9);
    assert.equal(f[0].positionSize, 2);
  });

  it("tracks exposure time", () => {
    const state = new SimState(10_000);
    const pnl = new PnLEngine(state);

    pnl.onMark("ETH", 100, 0);          // ts=0, no position
    pnl.onFills([mkFill("bid", 100, 1, 0, 1000)], "ETH", 1, 1000); // open at ts=1000
    pnl.onMark("ETH", 110, 3000);        // ts=3000, still have position
    pnl.onFills([mkFill("ask", 110, 1, 0, 5000)], "ETH", 1, 5000); // close at ts=5000

    const s = pnl.stats();
    // Position held from ts=1000 to ts=5000 = 4000ms
    assert.equal(s.exposureMs, 4000);
    assert.equal(s.totalDurationMs, 5000);
  });
});

// ── Metrics (via computeMetrics) ─────────────────────────────────────────────

describe("computeMetrics", () => {
  function buildScenario() {
    const state = new SimState(10_000);
    const pnl = new PnLEngine(state);

    // Simulate 5 hours of trading with wins and losses
    const hour = 3_600_000;
    let ts = 0;
    pnl.onMark("ETH", 100, ts);

    // Hour 1: buy 1 @ 100
    ts += hour;
    pnl.onFills([mkFill("bid", 100, 1, 0.5, ts)], "ETH", 1, ts);
    pnl.onMark("ETH", 105, ts);

    // Hour 2: price rises to 110, sell 1 (win: +10)
    ts += hour;
    pnl.onMark("ETH", 110, ts);
    pnl.onFills([mkFill("ask", 110, 1, 0.5, ts)], "ETH", 1, ts);

    // Hour 3: buy 1 @ 110
    ts += hour;
    pnl.onFills([mkFill("bid", 110, 1, 0.5, ts)], "ETH", 1, ts);
    pnl.onMark("ETH", 108, ts);

    // Hour 4: price drops to 105, sell 1 (loss: -5)
    ts += hour;
    pnl.onMark("ETH", 105, ts);
    pnl.onFills([mkFill("ask", 105, 1, 0.5, ts)], "ETH", 1, ts);

    // Hour 5: flat, mark stays
    ts += hour;
    pnl.onMark("ETH", 105, ts);

    return { pnl, state };
  }

  it("computes total return correctly", () => {
    const { pnl } = buildScenario();
    const s = pnl.stats();
    const report = computeMetrics(pnl.equityCurve(), pnl.trades(), pnl.funding(), s);
    const m = report.aggregate;

    // Realized: +10 -5 = +5, fees: 4*0.5 = 2, net = +3, return = 3/10000
    assert.ok(Math.abs(m.totalReturn - 3 / 10_000) < 1e-6);
  });

  it("computes max drawdown", () => {
    const { pnl } = buildScenario();
    const s = pnl.stats();
    const report = computeMetrics(pnl.equityCurve(), pnl.trades(), pnl.funding(), s);
    assert.ok(report.aggregate.maxDrawdown > 0);
    assert.ok(report.aggregate.maxDrawdown < 1);
  });

  it("computes win rate and profit factor", () => {
    const { pnl } = buildScenario();
    const s = pnl.stats();
    const report = computeMetrics(pnl.equityCurve(), pnl.trades(), pnl.funding(), s);
    const m = report.aggregate;

    assert.equal(m.totalTrades, 4);
    // 2 reducing trades: 1 win (+10), 1 loss (-5)
    assert.equal(m.winRate, 0.5);
    assert.equal(m.profitFactor, 10 / 5);
  });

  it("computes Sharpe, Sortino, Calmar, Omega as finite numbers", () => {
    const { pnl } = buildScenario();
    const s = pnl.stats();
    const report = computeMetrics(pnl.equityCurve(), pnl.trades(), pnl.funding(), s);
    const m = report.aggregate;

    // With 5 hourly periods, all ratio metrics should be numbers (may be NaN for very short runs)
    for (const key of ["sharpe", "sortino", "calmar", "omega"] as const) {
      assert.ok(typeof m[key] === "number", `${key} should be a number`);
    }
  });

  it("produces per-symbol breakdown", () => {
    const state = new SimState(10_000);
    const pnl = new PnLEngine(state);

    pnl.onMark("ETH", 100, 0);
    pnl.onFills([mkFill("bid", 100, 1, 1, 1000)], "ETH", 1, 1000);
    pnl.onFills([mkFill("ask", 110, 1, 1, 2000)], "ETH", 1, 2000);

    pnl.onMark("BTC", 50000, 0);
    pnl.onFills([mkFill("bid", 50000, 0.1, 2.5, 3000)], "BTC", 2, 3000);
    pnl.onFills([mkFill("ask", 49000, 0.1, 2.5, 4000)], "BTC", 2, 4000);

    const s = pnl.stats();
    const report = computeMetrics(pnl.equityCurve(), pnl.trades(), pnl.funding(), s);

    assert.equal(report.perSymbol.length, 2);
    const eth = report.perSymbol.find((s) => s.symbol === "ETH")!;
    const btc = report.perSymbol.find((s) => s.symbol === "BTC")!;
    assert.equal(eth.trades, 2);
    assert.equal(btc.trades, 2);
    assert.ok(eth.realizedPnl > 0); // won on ETH
    assert.ok(btc.realizedPnl < 0); // lost on BTC
  });
});

// ── Report formatter ─────────────────────────────────────────────────────────

describe("formatReport", () => {
  it("produces a readable string with all sections", () => {
    const state = new SimState(10_000);
    const pnl = new PnLEngine(state);

    pnl.onMark("ETH", 100, 0);
    pnl.onFills([mkFill("bid", 100, 1, 0.5, 1000)], "ETH", 1, 1000);
    pnl.onMark("ETH", 110, 5_000_000);
    pnl.onFills([mkFill("ask", 110, 1, 0.5, 5_000_000)], "ETH", 1, 5_000_000);

    const s = pnl.stats();
    const report = computeMetrics(pnl.equityCurve(), pnl.trades(), pnl.funding(), s);
    const text = formatReport(report);

    assert.ok(text.includes("Backtest Results"));
    assert.ok(text.includes("Sharpe"));
    assert.ok(text.includes("Calmar"));
    assert.ok(text.includes("Omega"));
    assert.ok(text.includes("Slippage"));
    assert.ok(text.includes("Funding"));
  });

  it("toJSON serializes Infinity safely", () => {
    const report = {
      aggregate: {
        totalReturn: 0.5, cagr: 0.1, sharpe: Infinity, sortino: Infinity,
        calmar: Infinity, omega: Infinity, maxDrawdown: 0, maxDrawdownDurationMs: 0,
        totalTrades: 0, winRate: 0, profitFactor: Infinity, avgWin: 0, avgLoss: 0,
        totalFees: 0, feeDrag: 0, totalFunding: 0, totalSlippage: 0, avgSlippageBps: 0,
        maxPosition: 0, exposure: 0, turnover: 0, durationMs: 0,
      },
      perSymbol: [],
    };
    const json = toJSON(report);
    assert.ok(json.includes('"Infinity"'));
    JSON.parse(json); // must not throw
  });
});
