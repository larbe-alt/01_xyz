/**
 * Phase 6 — Strategy framework: the stable contract every strategy plugs into.
 *
 * Strategies implement `Strategy` and only ever touch `StrategyContext`; they
 * never call the SDK or the core managers' write paths directly. Every order is
 * routed through `ctx.orders` (a guarded facade — see engine/context.ts) so the
 * risk guard runs on every entry automatically.
 */
import type { CandleResolution, WebSocketAccountUpdate } from "@n1xyz/nord-ts";
import type { Config } from "../config.js";
import type { Logger } from "../utils/logger.js";
import type { LocalBook } from "../data/feed.js";
import type { FeedSource } from "../data/feed-source.js";
import type { IPositions, IBalances, IAccount } from "../core/ports.js";
import type { RiskGuard } from "../risk/guard.js";
import type { RiskConfig } from "../risk/limits.js";
import type { sizeFromRisk, notionalToBase } from "../risk/sizing.js";
import type { bySymbol, byId, marketRoundPrice, marketRoundSize } from "../registry/markets.js";
import type { GuardedOrders } from "./context.js";

// ── Normalized feed events (identical for live and replay) ────────────────────
// We deliberately do NOT hand strategies the raw SDK WS shapes — both LiveFeed
// and the replay reader normalize into these so a strategy runs unchanged on
// live data or recorded data.

export interface FeedTrade {
  symbol: string;
  price: number;
  size: number;
  side: string; // taker side as reported by the source
  tradeId: number;
  ts: number; // server timestamp
}

export interface FeedCandle {
  symbol: string;
  resolution: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // quote volume
  openTime: number; // seconds
}

// ── The context handed to every strategy ──────────────────────────────────────

export interface StrategyContext<P = unknown> {
  /** Guarded order facade — every place/edit runs through the risk guard. */
  orders: GuardedOrders;
  positions: IPositions;
  balances: IBalances;
  account: IAccount;
  feed: FeedSource;
  risk: {
    guard: RiskGuard;
    sizeFromRisk: typeof sizeFromRisk;
    notionalToBase: typeof notionalToBase;
  };
  registry: {
    bySymbol: typeof bySymbol;
    byId: typeof byId;
    roundPrice: typeof marketRoundPrice;
    roundSize: typeof marketRoundSize;
  };
  logger: Logger;
  config: Config;
  /** Strategy-specific params, already parsed/validated by the strategy. */
  params: P;
  clock: { now(): number; serverNow(): number };
}

// ── The contract a strategy implements ────────────────────────────────────────

export interface Strategy<P = unknown> {
  name: string;
  /** Parse & validate the opaque `params` config block; return typed params or throw. */
  parseParams?(raw: unknown): P;
  init(ctx: StrategyContext<P>): Promise<void> | void;
  onTrade?(t: FeedTrade, ctx: StrategyContext<P>): Promise<void> | void;
  onBook?(book: LocalBook, ctx: StrategyContext<P>): Promise<void> | void;
  onCandle?(c: FeedCandle, ctx: StrategyContext<P>): Promise<void> | void;
  /** Fixed-interval tick (live only); `run.tickMs` controls cadence. */
  onTick?(ctx: StrategyContext<P>): Promise<void> | void;
  onAccount?(u: WebSocketAccountUpdate, ctx: StrategyContext<P>): Promise<void> | void;
  shutdown?(ctx: StrategyContext<P>): Promise<void> | void;
}

// ── Run / file config (the three-layer split: run / risk / params) ────────────

export interface RunConfig {
  markets: string[];
  tickMs?: number; // onTick cadence (default 1000)
  candleResolution?: CandleResolution; // subscribe candles when set
  refreshMs?: number; // account.fetchInfo() cadence (default 15000)
  flattenOnShutdown?: boolean;
}

export interface ReplayConfig {
  baseDir: string;
  env?: string; // defaults to config.network
  from?: number;
  to?: number;
  speed?: number;
}

export interface StrategyFileConfig {
  strategy: string;
  run: RunConfig;
  risk: RiskConfig;
  params?: unknown; // opaque to the framework; validated by the strategy
  dryRun?: boolean;
  replay?: ReplayConfig;
}
