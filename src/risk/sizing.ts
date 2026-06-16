import { Decimal } from "../utils/decimal.js";
import { marketRoundSize } from "../registry/markets.js";

export interface SizingParams {
  symbol: string;
  riskPct: number;             // fraction of equity to risk, e.g. 0.01 = 1%
  stopDistance: Decimal.Value; // |entry − stopLoss| in quote units (must be > 0)
  markPrice: Decimal.Value;    // current mark price
  equity: Decimal.Value;       // account.equity()
  maxLeverage?: number;        // leverage cap from RiskConfig; omit to skip clamp
}

export interface SizingResult {
  baseSize: Decimal;
  riskNotional: Decimal; // equity × riskPct
  leverageCapped: boolean;
}

/**
 * Position size from fixed-risk sizing:
 *   size = (equity × riskPct) / stopDistance
 * Then clamp to leverage cap:
 *   leverageCap = equity × maxLeverage / markPrice
 * Then round down to tick.
 *
 * Throws if stopDistance ≤ 0 or the result rounds to zero.
 */
export function sizeFromRisk(p: SizingParams): SizingResult {
  const equity = new Decimal(p.equity);
  const stopDistance = new Decimal(p.stopDistance);
  const markPrice = new Decimal(p.markPrice);

  if (stopDistance.lte(0)) throw new Error("stopDistance must be > 0");
  if (equity.lte(0)) throw new Error("equity must be > 0");
  if (markPrice.lte(0)) throw new Error("markPrice must be > 0");

  const riskNotional = equity.mul(p.riskPct);
  let rawBase = riskNotional.div(stopDistance);
  let leverageCapped = false;

  if (p.maxLeverage !== undefined && p.maxLeverage > 0) {
    const leverageCap = equity.mul(p.maxLeverage).div(markPrice);
    if (rawBase.gt(leverageCap)) {
      rawBase = leverageCap;
      leverageCapped = true;
    }
  }

  const baseSize = marketRoundSize(p.symbol, rawBase);
  if (baseSize.isZero()) {
    throw new Error(
      `sizeFromRisk produced zero after rounding for ${p.symbol} ` +
        `(rawBase=${rawBase.toString()})`,
    );
  }

  return { baseSize, riskNotional, leverageCapped };
}

/**
 * Convert a notional amount (in quote) to base units using markPrice.
 * Rounds down to tick.
 */
export function notionalToBase(
  symbol: string,
  notional: Decimal.Value,
  markPrice: Decimal.Value,
): Decimal {
  const base = new Decimal(notional).div(new Decimal(markPrice));
  return marketRoundSize(symbol, base);
}
