/**
 * StrategyContext assembly + the GuardedOrders facade.
 *
 * GuardedOrders is the enforcement point for "every order goes through risk
 * automatically": strategies receive this facade instead of the raw
 * OrderManager. It assembles a GuardCheckState (equity, IMF, positions, open
 * orders, mark price, account age) and runs guard.check() before any entry
 * reaches the engine. Reduce-only / cancel paths are pass-through (the guard
 * itself allows reduce-only unconditionally so positions can always be closed).
 */
import { Side } from "@n1xyz/nord-ts";
import { Decimal } from "../utils/decimal.js";
import { serverNow } from "../utils/time.js";
import { createLogger } from "../utils/logger.js";
import { bySymbol, byId, marketRoundPrice, marketRoundSize } from "../registry/markets.js";
import { sizeFromRisk, notionalToBase } from "../risk/sizing.js";
import type { Config } from "../config.js";
import type { Logger } from "../utils/logger.js";
import type { PlaceIntent, PlaceResult, NormalizedOrder } from "../core/orders.js";
import type { IOrderGateway, IAccount, IPositions, IBalances } from "../core/ports.js";
import type { RiskGuard, GuardCheckState } from "../risk/guard.js";
import { GuardDenyCode } from "../risk/guard.js";
import type { FeedSource } from "../data/feed-source.js";
import type { StrategyContext } from "./types.js";

const log = createLogger("engine:orders");

export class GuardRejectedError extends Error {
  constructor(
    public readonly code: GuardDenyCode,
    public readonly reason: string,
  ) {
    super(`Order rejected by risk guard [${code}]: ${reason}`);
    this.name = "GuardRejectedError";
  }
}

type EditChanges = {
  price?: Decimal.Value;
  size?: Decimal.Value;
  symbol: string;
  side: Side;
  type?: PlaceIntent["type"];
};

export interface GuardedOrdersDeps {
  guard: RiskGuard;
  account: IAccount;
  positions: IPositions;
  feed: FeedSource;
  /** Equity captured at runner start; basis for the daily-loss check. */
  sessionStartEquity: Decimal;
  dryRun?: boolean;
}

export class GuardedOrders {
  constructor(
    private readonly orders: IOrderGateway,
    private readonly deps: GuardedOrdersDeps,
  ) {}

  // ── Entry paths (guarded) ───────────────────────────────────────────────────

  async place(intent: PlaceIntent): Promise<PlaceResult> {
    this.assertAllowed(intent);
    if (this.deps.dryRun) return this.dryResult(intent);
    return this.orders.place(intent);
  }

  async edit(ref: bigint | number | { cid: bigint | number }, changes: EditChanges): Promise<PlaceResult> {
    const intent: PlaceIntent = {
      symbol: changes.symbol,
      side: changes.side,
      type: changes.type ?? "limit",
      price: changes.price,
      size: changes.size,
    };
    this.assertAllowed(intent);
    if (this.deps.dryRun) return this.dryResult(intent);
    return this.orders.edit(ref, changes);
  }

  async marketBuy(symbol: string, size: Decimal.Value, accountId?: number): Promise<PlaceResult> {
    return this.place({ symbol, side: Side.Bid, type: "market", size, accountId });
  }

  async marketSell(symbol: string, size: Decimal.Value, accountId?: number): Promise<PlaceResult> {
    return this.place({ symbol, side: Side.Ask, type: "market", size, accountId });
  }

  // ── Cancel / read paths (no new exposure → pass-through) ─────────────────────

  async cancel(orderId: bigint | number, accountId?: number): Promise<unknown> {
    if (this.deps.dryRun) {
      log.info("[dry-run] cancel", { orderId: orderId.toString() });
      return;
    }
    return this.orders.cancel(orderId as bigint, accountId);
  }

  async cancelByClientId(clientOrderId: bigint | number, accountId?: number): Promise<unknown> {
    if (this.deps.dryRun) {
      log.info("[dry-run] cancelByClientId", { cid: clientOrderId.toString() });
      return;
    }
    return this.orders.cancelByClientId(clientOrderId as bigint, accountId);
  }

  async cancelAll(symbol?: string, accountId?: number): Promise<void> {
    if (this.deps.dryRun) {
      log.info("[dry-run] cancelAll", { symbol });
      return;
    }
    return this.orders.cancelAll(symbol, accountId);
  }

  open(symbol?: string, accountId?: number): NormalizedOrder[] {
    return this.orders.open(symbol, accountId);
  }

  getById(orderId: number, accountId?: number): NormalizedOrder | null {
    return this.orders.getById(orderId, accountId);
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private assertAllowed(intent: PlaceIntent): void {
    const markPrice = this.resolveMarkPrice(intent);
    const result = this.deps.guard.check(intent, this.buildState(intent, markPrice));
    if (!result.allow) throw new GuardRejectedError(result.code, result.reason);
  }

  /**
   * Resolve a positive mark price for the risk check. A zero/absent mark would
   * collapse every notional/leverage/gross check to 0 and silently let oversized
   * orders through — so if neither a synced book mid nor a limit price is
   * available we REFUSE the order rather than risk-check it against a bad mark.
   */
  private resolveMarkPrice(intent: PlaceIntent): Decimal {
    const mid = this.deps.feed.getMid(intent.symbol);
    if (mid != null && mid > 0) return new Decimal(mid);
    if (intent.price != null) {
      const p = new Decimal(intent.price);
      if (p.gt(0)) return p;
    }
    throw new GuardRejectedError(
      GuardDenyCode.MarkPrice,
      `No reliable mark price for ${intent.symbol} (book unsynced and no usable limit price)`,
    );
  }

  private buildState(intent: PlaceIntent, markPrice: Decimal): GuardCheckState {
    const { account, positions, sessionStartEquity } = this.deps;
    return {
      equity: account.equity(),
      currentImfNotional: new Decimal(account.rawMargins().imf),
      positions: positions.list(),
      openOrders: this.orders.open(),
      sessionStartEquity,
      markPrice,
      accountAgeMs: account.ageMs(),
    };
  }

  private dryResult(intent: PlaceIntent): PlaceResult {
    const cid = intent.clientOrderId ?? BigInt(0);
    log.info("[dry-run] would place", {
      symbol: intent.symbol,
      side: intent.side,
      type: intent.type,
      price: intent.price?.toString(),
      size: intent.size?.toString(),
      reduceOnly: intent.reduceOnly ?? false,
    });
    return {
      actionId: BigInt(0),
      fills: [],
      reducedOrders: [],
      selfTradeCancels: [],
      clientOrderId: cid,
    };
  }
}

// ── Context assembly ──────────────────────────────────────────────────────────

export function buildContext<P>(args: {
  orders: GuardedOrders;
  positions: IPositions;
  balances: IBalances;
  account: IAccount;
  feed: FeedSource;
  guard: RiskGuard;
  config: Config;
  params: P;
  logger: Logger;
}): StrategyContext<P> {
  return {
    orders: args.orders,
    positions: args.positions,
    balances: args.balances,
    account: args.account,
    feed: args.feed,
    risk: { guard: args.guard, sizeFromRisk, notionalToBase },
    registry: { bySymbol, byId, roundPrice: marketRoundPrice, roundSize: marketRoundSize },
    logger: args.logger,
    config: args.config,
    params: args.params,
    clock: { now: () => Date.now(), serverNow },
  };
}
