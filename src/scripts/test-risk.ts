/**
 * Phase 5 risk layer smoke test — unit checks + optional live devnet check.
 * Usage: npm run test-risk
 */

import "../utils/polyfills.js";
import { Decimal } from "../utils/decimal.js";
import { Side } from "@n1xyz/nord-ts";
import { RiskGuard, GuardDenyCode } from "../risk/guard.js";
import { sizeFromRisk } from "../risk/sizing.js";
import type { RiskConfig } from "../risk/limits.js";
import type { GuardCheckState, GuardCheckResult } from "../risk/guard.js";
import type { PlaceIntent } from "../core/orders.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function expect(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// Assert a check was denied with a specific code.
function expectDeny(label: string, result: GuardCheckResult, code: GuardDenyCode): void {
  expect(label, !result.allow && result.code === code);
}

function makeState(overrides?: Partial<GuardCheckState>): GuardCheckState {
  return {
    equity: new Decimal(10_000),
    currentImfNotional: new Decimal(500),
    positions: [],
    openOrders: [],
    sessionStartEquity: new Decimal(10_000),
    markPrice: new Decimal(30_000),
    accountAgeMs: 1_000,
    ...overrides,
  };
}

function makeIntent(overrides?: Partial<PlaceIntent>): PlaceIntent {
  return {
    symbol: "BTCUSD",
    side: Side.Bid,
    type: "limit",
    price: 30_000,
    size: 0.001,
    ...overrides,
  };
}

const BASE_CONFIG: RiskConfig = {
  markets: [
    {
      symbol: "BTCUSD",
      maxPositionBase: 1,          // 1 BTC
      maxPositionNotional: 50_000,
      maxOrderBase: 0.5,
      maxOrderNotional: 20_000,
      maxLeverage: 10,
      maxOpenOrders: 5,
    },
  ],
  defaultMaxLeverage: 5,
  maxTotalGrossNotional: 100_000,
  minMarginBufferPct: 0.1,         // keep 10% equity free above IMF
  maxDailyLossUsdc: 500,
  maxAccountAgeSec: 30,
};

// ── Registry bootstrap (needed for symbol lookups) ────────────────────────────

import { getNord } from "../client.js";
import { initMarkets } from "../registry/markets.js";

let registryReady = false;

async function bootstrapRegistry() {
  try {
    const nord = await getNord();
    initMarkets(nord);
    registryReady = true;
  } catch {
    console.warn("  [skip] Could not bootstrap registry — skipping symbol-dependent tests");
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function runUnitTests() {
  // Guard is symbol-agnostic for kill-switch / stale tests so we can run those
  // without the registry.  Symbol-dependent checks (leverage, position, sizing)
  // run only when registryReady.

  console.log("\n── Kill-switch ──");
  {
    const guard = new RiskGuard(BASE_CONFIG);
    guard.trip("manual test");
    const r = guard.check(makeIntent(), makeState());
    expectDeny("kill-switch blocks entry", r, GuardDenyCode.KillSwitch);
    expect("isActive() true after trip", guard.isActive());

    const rReduce = guard.check(makeIntent({ reduceOnly: true }), makeState());
    expect("reduce-only bypasses kill-switch", rReduce.allow);

    guard.reset();
    expect("isActive() false after reset", !guard.isActive());
  }

  console.log("\n── Stale account ──");
  {
    const guard = new RiskGuard(BASE_CONFIG);
    const r = guard.check(makeIntent(), makeState({ accountAgeMs: 60_000 }));
    expectDeny("stale account denied", r, GuardDenyCode.StaleAccount);
  }

  if (!registryReady) {
    console.log("\n[Registry unavailable — skipping symbol-dependent tests]\n");
    return;
  }

  console.log("\n── Reduce-only bypass ──");
  {
    const guard = new RiskGuard(BASE_CONFIG);
    // Set up state that would fail every size check
    const state = makeState({
      equity: new Decimal(100),
      currentImfNotional: new Decimal(200),
    });
    const intent = makeIntent({ size: 100, price: 30_000, reduceOnly: true });
    const r = guard.check(intent, state);
    expect("reduce-only bypasses all size checks", r.allow);
  }

  console.log("\n── Per-order notional cap ──");
  {
    const guard = new RiskGuard(BASE_CONFIG);
    // 1 BTC × $30k = $30k > $20k cap
    const r = guard.check(makeIntent({ size: 1, price: 30_000 }), makeState());
    expectDeny("order notional > cap denied", r, GuardDenyCode.OrderNotional);
  }

  console.log("\n── Per-order base cap ──");
  {
    const guard = new RiskGuard(BASE_CONFIG);
    // 0.6 BTC × $30k = $18k < $20k notional cap, but base 0.6 > 0.5 base cap
    const r = guard.check(makeIntent({ size: 0.6, price: 30_000 }), makeState());
    expectDeny("order base > cap denied", r, GuardDenyCode.OrderBase);
  }

  console.log("\n── Leverage ──");
  {
    const guard = new RiskGuard(BASE_CONFIG);
    // equity=1000, maxLeverage=10 → cap = 10,000 notional
    // order = 0.4 BTC × $30k = $12k > $10k
    const r = guard.check(
      makeIntent({ size: 0.4, price: 30_000 }),
      makeState({ equity: new Decimal(1_000) }),
    );
    expectDeny("over-leveraged order denied", r, GuardDenyCode.Leverage);
  }

  console.log("\n── Position size cap ──");
  {
    const guard = new RiskGuard(BASE_CONFIG);
    // Max position = 1 BTC; order = 0.6 BTC with 0.5 BTC existing
    const state = makeState({
      positions: [{
        marketId: 0,
        symbol: "BTCUSD",
        baseSize: new Decimal(0.6),
        isLong: true,
        entryPrice: new Decimal(28_000),
        unrealizedPnl: new Decimal(1_200),
        fundingPnl: new Decimal(0),
        openOrders: 0,
      }],
    });
    const r = guard.check(makeIntent({ size: 0.5, price: 30_000 }), state);
    expectDeny("oversized position denied", r, GuardDenyCode.Position);
  }

  console.log("\n── Position notional cap ──");
  {
    // Loosen base cap so the NOTIONAL cap is the binding limit.
    const guard = new RiskGuard({
      ...BASE_CONFIG,
      markets: [{ ...BASE_CONFIG.markets![0], maxPositionBase: 10, maxPositionNotional: 35_000 }],
    });
    // existing 0.8 BTC ($24k) + order 0.5 BTC ($15k) = $39k notional > $35k cap
    const state = makeState({
      positions: [{
        marketId: 0,
        symbol: "BTCUSD",
        baseSize: new Decimal(0.8),
        isLong: true,
        entryPrice: new Decimal(30_000),
        unrealizedPnl: new Decimal(0),
        fundingPnl: new Decimal(0),
        openOrders: 0,
      }],
    });
    const r = guard.check(makeIntent({ size: 0.5, price: 30_000 }), state);
    expectDeny("oversized position notional denied", r, GuardDenyCode.PositionNotional);
  }

  console.log("\n── Open orders cap ──");
  {
    const guard = new RiskGuard(BASE_CONFIG);
    // maxOpenOrders = 5; inject 5 existing
    const openOrders = Array.from({ length: 5 }, (_, i) => ({
      orderId: i,
      marketId: 0,
      symbol: "BTCUSD",
      side: Side.Bid,
      size: new Decimal(0.001),
      price: new Decimal(29_000),
      originalOrderSize: new Decimal(0.001),
      clientOrderId: i,
    }));
    const r = guard.check(makeIntent(), makeState({ openOrders }));
    expectDeny("too many open orders denied", r, GuardDenyCode.OpenOrders);
  }

  console.log("\n── Gross exposure ──");
  {
    const guard = new RiskGuard({ ...BASE_CONFIG, maxTotalGrossNotional: 5_000 });
    // Existing positions worth $5k + new order = over cap
    const state = makeState({
      positions: [{
        marketId: 0,
        symbol: "BTCUSD",
        baseSize: new Decimal(0.1),  // 0.1 BTC × $30k = $3k
        isLong: true,
        entryPrice: new Decimal(30_000),
        unrealizedPnl: new Decimal(0),
        fundingPnl: new Decimal(0),
        openOrders: 0,
      }],
    });
    // Order: 0.1 BTC × $30k = $3k; total = $6k > $5k
    const r = guard.check(makeIntent({ size: 0.1, price: 30_000 }), state);
    expectDeny("gross exposure exceeded denied", r, GuardDenyCode.GrossExposure);
  }

  console.log("\n── Margin buffer ──");
  {
    // equity=10k, order = 0.1 BTC × $30k = $3k notional × imf(BTCUSD ≈ 0.02) ≈ 60 added.
    // With minMarginBufferPct=0.1, cap = 0.9.
    // To fail: currentImfNotional=9500 → (9500+60)/10000 = 0.956 > 0.9
    const guard = new RiskGuard(BASE_CONFIG);
    const r = guard.check(
      makeIntent({ size: 0.1, price: 30_000 }),
      makeState({ currentImfNotional: new Decimal(9_500) }),
    );
    expectDeny("insufficient margin buffer denied", r, GuardDenyCode.MarginBuffer);
  }

  console.log("\n── Daily loss limit + auto-trip ──");
  {
    const guard = new RiskGuard(BASE_CONFIG);
    // sessionStartEquity=10k, equity=9400 → drawdown=600 > limit(500)
    const state = makeState({
      equity: new Decimal(9_400),
      sessionStartEquity: new Decimal(10_000),
    });
    const r = guard.check(makeIntent(), state);
    expectDeny("daily loss limit denied", r, GuardDenyCode.DailyLoss);
    expect("kill-switch trips on daily loss", guard.isActive());
  }

  console.log("\n── sizeFromRisk ──");
  {
    // equity=10k, riskPct=1%, stopDistance=$50, mark=$30k
    // rawBase = 100/50 = 2 BTC; leverageCap = 10k*10/30k = 3.33 BTC → not capped
    const result = sizeFromRisk({
      symbol: "BTCUSD",
      riskPct: 0.01,
      stopDistance: 50,
      markPrice: 30_000,
      equity: 10_000,
      maxLeverage: 10,
    });
    expect("sizeFromRisk positive result", result.baseSize.gt(0));
    expect("sizeFromRisk not leverage-capped", !result.leverageCapped);
    // BTCUSD sizeDecimals should be ≤ 5
    expect("sizeFromRisk tick-valid (≤5 dp)", result.baseSize.decimalPlaces() <= 5);
  }

  {
    // equity=1000, riskPct=50%, stopDistance=1, mark=30k
    // rawBase = 500; leverageCap = 1000*2/30000 = 0.0667 → capped
    const result = sizeFromRisk({
      symbol: "BTCUSD",
      riskPct: 0.5,
      stopDistance: 1,
      markPrice: 30_000,
      equity: 1_000,
      maxLeverage: 2,
    });
    expect("sizeFromRisk leverage clamp fires", result.leverageCapped);
  }

  {
    let threw = false;
    try { sizeFromRisk({ symbol: "BTCUSD", riskPct: 0.01, stopDistance: 0, markPrice: 30_000, equity: 10_000 }); }
    catch { threw = true; }
    expect("sizeFromRisk throws on zero stopDistance", threw);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

await bootstrapRegistry();
await runUnitTests();

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
