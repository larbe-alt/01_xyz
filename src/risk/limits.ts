import { Decimal } from "../utils/decimal.js";

export interface MarketRiskConfig {
  symbol: string;
  maxPositionBase?: Decimal.Value;      // max total position in base units
  maxPositionNotional?: Decimal.Value;  // max total position in quote (mark × base)
  maxOrderBase?: Decimal.Value;         // per-order base size cap
  maxOrderNotional?: Decimal.Value;     // per-order notional cap (price × size)
  maxLeverage?: number;                 // max (currentPosNotional + orderNotional) / equity
  maxOpenOrders?: number;               // max open orders for this market
}

export interface RiskConfig {
  markets?: MarketRiskConfig[];

  // Fallback values when no per-market entry matches
  defaultMaxLeverage?: number;
  defaultMaxOrderNotional?: Decimal.Value;
  defaultMaxPositionNotional?: Decimal.Value;
  defaultMaxOpenOrders?: number;

  // Cross-market limits
  maxTotalGrossNotional?: Decimal.Value; // sum of |pos notional| across all markets
  minMarginBufferPct?: number;           // projected imf/equity must stay ≤ (1 − buffer)
                                         // e.g. 0.1 means keep 10% equity free above IMF
  maxDailyLossUsdc?: Decimal.Value;      // drawdown from session-start equity; trips kill-switch
  maxAccountAgeSec?: number;             // refuse to trade if account state older than this
}

// "Effectively unlimited" sentinel for unset caps.
export const UNLIMITED = new Decimal("1e18");

/** True when a numeric cap was set to the UNLIMITED sentinel (i.e. no real cap). */
export function isUnlimited(v: number): boolean {
  return !Number.isFinite(v) || v >= 1e17;
}

export function resolveMarketConfig(
  symbol: string,
  config: RiskConfig,
): Required<Omit<MarketRiskConfig, "symbol">> {
  const market = config.markets?.find((m) => m.symbol === symbol);
  return {
    maxPositionBase: market?.maxPositionBase ?? UNLIMITED,
    maxPositionNotional: market?.maxPositionNotional ?? config.defaultMaxPositionNotional ?? UNLIMITED,
    maxOrderBase: market?.maxOrderBase ?? UNLIMITED,
    maxOrderNotional: market?.maxOrderNotional ?? config.defaultMaxOrderNotional ?? UNLIMITED,
    maxLeverage: market?.maxLeverage ?? config.defaultMaxLeverage ?? 20,
    maxOpenOrders: market?.maxOpenOrders ?? config.defaultMaxOpenOrders ?? 50,
  };
}
