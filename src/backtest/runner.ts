import { OrderBook } from "../sim/book.js";
import { MatchingEngine } from "../sim/matching.js";
import {
  SimState,
  SimOrderGateway,
  SimAccount,
  SimPositions,
  SimBalances,
} from "../sim/adapters.js";
import { PnLEngine } from "./pnl.js";
import { computeMetrics, type FullReport } from "./metrics.js";
import { SimFeedSource } from "./feed.js";
import { RiskGuard } from "../risk/guard.js";
import { GuardedOrders, buildContext } from "../engine/context.js";
import { initMarketsOffline, type MarketMeta } from "../registry/markets.js";
import { loadNative01Market, type Native01Event } from "../sim/sources/native01.js";
import { createLogger } from "../utils/logger.js";
import { Decimal } from "../utils/decimal.js";
import type { BacktestConfig, BacktestMarketConfig } from "./config.js";
import type { Strategy, FeedTrade } from "../engine/types.js";
import type { Config } from "../config.js";

const log = createLogger("backtest:runner");

export interface BacktestEvent {
  symbol: string;
  marketId: number;
  event: Native01Event;
}

export async function loadBacktestData(config: BacktestConfig): Promise<BacktestEvent[]> {
  const all: BacktestEvent[] = [];
  for (const mkt of config.markets) {
    const events = await loadNative01Market({
      dir: config.data.dir,
      env: config.data.env,
      market: mkt.symbol,
    });
    let filtered = events;
    if (config.data.from != null) filtered = filtered.filter((e) => e.ts >= config.data.from!);
    if (config.data.to != null) filtered = filtered.filter((e) => e.ts <= config.data.to!);
    for (const event of filtered) {
      all.push({ symbol: mkt.symbol, marketId: mkt.marketId, event });
    }
    log.info("Loaded market data", { symbol: mkt.symbol, events: filtered.length });
  }
  all.sort((a, b) => a.event.ts - b.event.ts);
  return all;
}

export async function runBacktest(
  config: BacktestConfig,
  events: BacktestEvent[],
  strategy: Strategy<any>,
): Promise<FullReport> {
  if (events.length === 0) {
    throw new Error("No events — check data directory and market symbols");
  }

  // ── Registry ──────────────────────────────────────────────────────────────
  initMarketsOffline(config.markets.map(toMarketMeta));

  // ── Sim infrastructure ────────────────────────────────────────────────────
  const fees = {
    makerBps: config.fees?.makerBps ?? 1,
    takerBps: config.fees?.takerBps ?? 3.5,
  };
  const state = new SimState(config.initialEquity);
  const pnl = new PnLEngine(state, config.curveIntervalMs ?? 0);
  const feed = new SimFeedSource();
  let virtualTs = 0;

  const gateway = new SimOrderGateway(state, () => virtualTs);
  gateway.setFillHandler((fills, sym, mid, ts) => pnl.onFills(fills, sym, mid, ts));

  const simBooks = new Map<string, OrderBook>();
  const engines = new Map<string, MatchingEngine>();
  for (const mkt of config.markets) {
    const book = new OrderBook();
    const engine = new MatchingEngine(book, fees);
    simBooks.set(mkt.symbol, book);
    engines.set(mkt.symbol, engine);
    gateway.addMarket(mkt.symbol, mkt.marketId, engine);
    feed.addBook(mkt.symbol, book);
  }

  // ── Context ───────────────────────────────────────────────────────────────
  const guard = new RiskGuard(config.risk, async () => {
    log.warn("Kill-switch tripped in backtest");
    await gateway.cancelAll();
  });

  const simAccount = new SimAccount(state);
  const simPositions = new SimPositions(state, gateway);
  const simBalances = new SimBalances(state);

  const guardedOrders = new GuardedOrders(gateway, {
    guard,
    account: simAccount,
    positions: simPositions,
    feed,
    sessionStartEquity: new Decimal(config.initialEquity),
    dryRun: false,
  });

  const params = strategy.parseParams
    ? strategy.parseParams(config.params)
    : (config.params ?? {});

  const dummyConfig: Config = {
    network: config.data.env === "mainnet" ? "mainnet" : "devnet",
    solanaRpc: "",
    webServerUrl: "",
    wsHost: "",
    appKey: "",
    privateKey: undefined,
  };

  const ctx = buildContext({
    orders: guardedOrders,
    positions: simPositions,
    balances: simBalances,
    account: simAccount,
    feed,
    guard,
    config: dummyConfig,
    params,
    logger: createLogger(`strategy:${strategy.name}`),
  });
  ctx.clock = { now: () => virtualTs, serverNow: () => virtualTs };

  // ── Init strategy ─────────────────────────────────────────────────────────
  await strategy.init(ctx);

  // ── Event loop ────────────────────────────────────────────────────────────
  const tickMs = config.tickMs ?? 1000;
  let nextTickTs = events[0].event.ts + tickMs;

  for (const { symbol, marketId, event } of events) {
    virtualTs = event.ts;

    while (virtualTs >= nextTickTs) {
      if (strategy.onTick) await callHook(() => strategy.onTick!(ctx));
      nextTickTs += tickMs;
    }

    const simBook = simBooks.get(symbol)!;

    switch (event.kind) {
      case "snapshot": {
        simBook.clear();
        for (const [p, sz] of event.bids) simBook.setLevel("bid", p, sz);
        for (const [p, sz] of event.asks) simBook.setLevel("ask", p, sz);
        feed.sync(symbol, event.ts);
        if (strategy.onBook) {
          const lb = feed.getBook(symbol);
          if (lb) await callHook(() => strategy.onBook!(lb, ctx));
        }
        break;
      }
      case "delta": {
        for (const [p, sz] of event.bids) simBook.setLevel("bid", p, sz);
        for (const [p, sz] of event.asks) simBook.setLevel("ask", p, sz);
        feed.sync(symbol, event.ts);
        if (strategy.onBook) {
          const lb = feed.getBook(symbol);
          if (lb) await callHook(() => strategy.onBook!(lb, ctx));
        }
        break;
      }
      case "trade": {
        const { trade } = event;
        const engine = engines.get(symbol)!;
        const makerFills = engine.onTrade(trade);
        if (makerFills.length > 0) {
          pnl.onFills(makerFills, symbol, marketId, event.ts);
        }
        pnl.onMark(symbol, trade.price, event.ts);
        if (strategy.onTrade) {
          const ft: FeedTrade = {
            symbol,
            price: trade.price,
            size: trade.size,
            side: trade.side,
            tradeId: 0,
            ts: event.ts,
          };
          await callHook(() => strategy.onTrade!(ft, ctx));
        }
        break;
      }
    }
  }

  // ── Shutdown ──────────────────────────────────────────────────────────────
  await callHook(() => strategy.shutdown?.(ctx));

  return computeMetrics(pnl.equityCurve(), pnl.trades(), pnl.funding(), pnl.stats());
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toMarketMeta(m: BacktestMarketConfig): MarketMeta {
  return {
    marketId: m.marketId,
    symbol: m.symbol,
    priceDecimals: m.priceDecimals ?? 2,
    sizeDecimals: m.sizeDecimals ?? 4,
    baseTokenId: 0,
    quoteTokenId: 0,
    imf: m.imf ?? 0.1,
    mmf: m.mmf ?? 0.05,
    cmf: m.cmf ?? 0.025,
  };
}

async function callHook(fn: () => unknown): Promise<void> {
  try {
    const result = fn();
    if (result != null && typeof (result as any).then === "function") {
      await result;
    }
  } catch (e) {
    log.error("Strategy hook threw", { error: e instanceof Error ? e.message : String(e) });
  }
}
