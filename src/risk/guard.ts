import { Decimal } from "../utils/decimal.js";
import { createLogger } from "../utils/logger.js";
import { bySymbol } from "../registry/markets.js";
import type { RiskConfig } from "./limits.js";
import { resolveMarketConfig } from "./limits.js";
import type { PlaceIntent } from "../core/orders.js";
import type { Position } from "../core/positions.js";
import type { NormalizedOrder } from "../core/orders.js";

const log = createLogger("risk:guard");

export enum GuardDenyCode {
  KillSwitch       = "KILL_SWITCH",
  StaleAccount     = "STALE_ACCOUNT",
  MarkPrice        = "MARK_PRICE",
  OrderNotional    = "ORDER_NOTIONAL",
  OrderBase        = "ORDER_BASE",
  Leverage         = "LEVERAGE",
  Position         = "POSITION",
  PositionNotional = "POSITION_NOTIONAL",
  OpenOrders       = "OPEN_ORDERS",
  GrossExposure    = "GROSS_EXPOSURE",
  MarginBuffer     = "MARGIN_BUFFER",
  DailyLoss        = "DAILY_LOSS",
}

export type GuardCheckResult =
  | { allow: true }
  | { allow: false; reason: string; code: GuardDenyCode };

export interface GuardCheckState {
  equity: Decimal;
  // user.margins[id].imf — existing initial margin fraction usage in USDC
  currentImfNotional: Decimal;
  positions: Position[];
  openOrders: NormalizedOrder[];
  // snapshot taken when guard was initialized (or manually reset); used for daily loss
  sessionStartEquity: Decimal;
  markPrice: Decimal;    // live mark for the target market
  accountAgeMs: number;  // account.ageMs()
}

export class RiskGuard {
  // null = inactive; non-null = tripped, holds the reason.
  private killSwitchReason: string | null = null;

  // Cross-market limits, parsed once (config is immutable for the guard's life).
  private readonly maxAccountAgeMs: number;
  private readonly maxTotalGrossNotional?: Decimal;
  private readonly maxImfRatio?: Decimal; // projected imf/equity must stay ≤ this
  private readonly maxDailyLossUsdc?: Decimal;
  // Per-symbol resolved config, memoized so check() skips the find()+Decimal churn.
  private readonly marketCfgCache = new Map<string, ReturnType<typeof resolveMarketConfig>>();

  constructor(
    private readonly config: RiskConfig,
    // Called async (fire-and-forget) when kill-switch trips.
    // Phase 6 runner passes: () => Promise.all([orders.cancelAll(), positions.closeAll()])
    private readonly onTrip?: () => Promise<void>,
  ) {
    this.maxAccountAgeMs = (config.maxAccountAgeSec ?? 30) * 1000;
    this.maxTotalGrossNotional = config.maxTotalGrossNotional !== undefined
      ? new Decimal(config.maxTotalGrossNotional)
      : undefined;
    this.maxImfRatio = config.minMarginBufferPct !== undefined
      ? new Decimal(1).sub(config.minMarginBufferPct)
      : undefined;
    this.maxDailyLossUsdc = config.maxDailyLossUsdc !== undefined
      ? new Decimal(config.maxDailyLossUsdc)
      : undefined;
  }

  private marketCfg(symbol: string): ReturnType<typeof resolveMarketConfig> {
    let cfg = this.marketCfgCache.get(symbol);
    if (!cfg) {
      cfg = resolveMarketConfig(symbol, this.config);
      this.marketCfgCache.set(symbol, cfg);
    }
    return cfg;
  }

  // ── Kill-switch controls ──────────────────────────────────────────────────

  trip(reason: string): void {
    if (this.killSwitchReason !== null) return;
    this.killSwitchReason = reason;
    log.warn("Kill-switch tripped", { reason });
    if (this.onTrip) {
      this.onTrip().catch((err) =>
        log.error("onTrip callback failed", { err: String(err) }),
      );
    }
  }

  reset(): void {
    this.killSwitchReason = null;
    log.info("Kill-switch reset");
  }

  isActive(): boolean {
    return this.killSwitchReason !== null;
  }

  /** Return the resolved per-market risk config for a symbol (memoized). */
  getMarketConfig(symbol: string): ReturnType<typeof resolveMarketConfig> {
    return this.marketCfg(symbol);
  }

  // ── Pre-trade gate ────────────────────────────────────────────────────────

  check(intent: PlaceIntent, state: GuardCheckState): GuardCheckResult {
    // 1. Reduce-only orders bypass everything — you must be able to close positions
    //    even when the kill-switch is active or account state is stale.
    if (intent.reduceOnly) {
      return { allow: true };
    }

    // 2. Kill-switch blocks new entries (reduce-only already passed above)
    if (this.killSwitchReason !== null) {
      return deny(GuardDenyCode.KillSwitch, `Kill-switch active: ${this.killSwitchReason}`);
    }

    // 3. Stale account state
    if (state.accountAgeMs > this.maxAccountAgeMs) {
      return deny(
        GuardDenyCode.StaleAccount,
        `Account state is ${Math.round(state.accountAgeMs / 1000)}s old ` +
          `(max ${this.maxAccountAgeMs / 1000}s)`,
      );
    }

    const marketMeta = bySymbol(intent.symbol);
    const marketCfg = this.marketCfg(intent.symbol);

    // Derive order notional: price × size (or markPrice × size for market orders)
    const orderPrice = intent.price !== undefined
      ? new Decimal(intent.price)
      : state.markPrice;
    const orderBase = intent.size !== undefined
      ? new Decimal(intent.size)
      : intent.quoteSize !== undefined
        ? new Decimal(intent.quoteSize).div(orderPrice)
        : new Decimal(0);
    const orderNotional = orderBase.mul(orderPrice);

    const ratioVsEquity = (n: Decimal): Decimal =>
      state.equity.gt(0) ? n.div(state.equity) : new Decimal(Infinity);

    // 4. Per-order notional cap
    const maxOrderNotional = new Decimal(marketCfg.maxOrderNotional);
    if (orderNotional.gt(maxOrderNotional)) {
      return deny(
        GuardDenyCode.OrderNotional,
        `Order notional ${orderNotional.toFixed(2)} exceeds cap ${maxOrderNotional.toFixed(2)}`,
      );
    }

    // 4b. Per-order base size cap
    const maxOrderBase = new Decimal(marketCfg.maxOrderBase);
    if (orderBase.gt(maxOrderBase)) {
      return deny(
        GuardDenyCode.OrderBase,
        `Order base ${orderBase.toString()} exceeds cap ${maxOrderBase.toString()}`,
      );
    }

    // Single pass over positions: locate this market's position and total gross notional.
    let currentPos: Position | undefined;
    let totalGross = new Decimal(0);
    for (const p of state.positions) {
      totalGross = totalGross.add(p.baseSize.mul(state.markPrice));
      if (p.marketId === marketMeta.marketId) currentPos = p;
    }
    const currentBase = currentPos?.baseSize ?? new Decimal(0);
    const currentPosNotional = currentBase.mul(state.markPrice);

    // 5. Projected leverage: (currentPosNotional + orderNotional) / equity
    const projectedNotional = currentPosNotional.add(orderNotional);
    const projectedLeverage = ratioVsEquity(projectedNotional);
    if (projectedLeverage.gt(marketCfg.maxLeverage)) {
      return deny(
        GuardDenyCode.Leverage,
        `Projected leverage ${projectedLeverage.toFixed(2)}x exceeds max ${marketCfg.maxLeverage}x`,
      );
    }

    // 6. Position size cap (base)
    const maxPositionBase = new Decimal(marketCfg.maxPositionBase);
    const projectedBase = currentBase.add(orderBase);
    if (projectedBase.gt(maxPositionBase)) {
      return deny(
        GuardDenyCode.Position,
        `Position ${projectedBase.toString()} exceeds max base ${maxPositionBase.toString()}`,
      );
    }

    // 6b. Position notional cap (projected position value at mark)
    const maxPositionNotional = new Decimal(marketCfg.maxPositionNotional);
    if (projectedNotional.gt(maxPositionNotional)) {
      return deny(
        GuardDenyCode.PositionNotional,
        `Position notional ${projectedNotional.toFixed(2)} exceeds cap ${maxPositionNotional.toFixed(2)}`,
      );
    }

    // 7. Open-order count for this market
    const marketOpenOrders = state.openOrders.filter(
      (o) => o.marketId === marketMeta.marketId,
    );
    if (marketOpenOrders.length >= marketCfg.maxOpenOrders) {
      return deny(
        GuardDenyCode.OpenOrders,
        `Open orders ${marketOpenOrders.length} at max (${marketCfg.maxOpenOrders}) for ${intent.symbol}`,
      );
    }

    // 8. Total gross exposure across all markets
    if (this.maxTotalGrossNotional !== undefined) {
      const projectedGross = totalGross.add(orderNotional);
      if (projectedGross.gt(this.maxTotalGrossNotional)) {
        return deny(
          GuardDenyCode.GrossExposure,
          `Gross exposure ${projectedGross.toFixed(2)} exceeds max ${this.maxTotalGrossNotional.toFixed(2)}`,
        );
      }
    }

    // 9. Projected margin buffer: (currentImfNotional + orderNotional × market.imf) / equity
    if (this.maxImfRatio !== undefined) {
      const projectedImf = state.currentImfNotional.add(
        orderNotional.mul(marketMeta.imf),
      );
      const projectedRatio = ratioVsEquity(projectedImf);
      if (projectedRatio.gt(this.maxImfRatio)) {
        return deny(
          GuardDenyCode.MarginBuffer,
          `Projected IMF ratio ${projectedRatio.toFixed(4)} exceeds cap ${this.maxImfRatio.toFixed(4)} ` +
            `(minBuffer=${this.config.minMarginBufferPct})`,
        );
      }
    }

    // 10. Daily loss limit — auto-trips kill-switch on breach
    if (this.maxDailyLossUsdc !== undefined) {
      const drawdown = state.sessionStartEquity.sub(state.equity);
      if (drawdown.gt(this.maxDailyLossUsdc)) {
        this.trip(`Daily loss ${drawdown.toFixed(2)} USDC exceeded limit ${this.maxDailyLossUsdc.toFixed(2)} USDC`);
        return deny(
          GuardDenyCode.DailyLoss,
          `Daily loss ${drawdown.toFixed(2)} USDC exceeds limit ${this.maxDailyLossUsdc.toFixed(2)} USDC`,
        );
      }
    }

    return { allow: true };
  }
}

function deny(code: GuardDenyCode, reason: string): GuardCheckResult {
  log.warn("Order denied by risk guard", { code, reason });
  return { allow: false, reason, code };
}
