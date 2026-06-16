/**
 * Pure simulation types. Deliberately SDK-free and number-based (not Decimal)
 * so the matching engine is trivially unit-testable and fast over millions of
 * recorded events. Rounding/precision is the caller's concern (a real strategy
 * rounds to tick via the registry before submitting).
 */

/** bid = buy, ask = sell. Matches the engine's internal book sides. */
export type Side = "bid" | "ask";

export type OrderType = "limit" | "postOnly" | "ioc" | "fok" | "market";

export interface SimOrderIntent {
  /** Client order id — unique per resting order. */
  cid: number;
  side: Side;
  type: OrderType;
  /** Limit price; required for limit/postOnly. Ignored for market. Acts as the cap for ioc/fok. */
  price?: number;
  /** Base size. */
  size: number;
  /** Reduce-only orders are clamped to the closable position and never flip it. */
  reduceOnly?: boolean;
}

export interface Fill {
  cid: number;
  side: Side;
  price: number;
  size: number;
  /** Signed fee in quote units: positive = paid, negative = rebate received. */
  fee: number;
  liquidity: "maker" | "taker";
  ts: number;
}

export interface RestingOrder {
  cid: number;
  side: Side;
  price: number;
  remaining: number;
  /**
   * Base volume resting AHEAD of us at our price level when we joined. Trade-through
   * volume burns this down before it can fill us — this is the conservative
   * back-of-queue model. Only recorded TRADES reduce it (cancellations ahead of us
   * are ambiguous, so we pessimistically ignore them).
   */
  queueAhead: number;
  /** Time the order became active (matchable). Enforces no same-event look-ahead. */
  ts: number;
}

export interface FeeModel {
  /** Maker fee in basis points; negative = rebate. */
  makerBps: number;
  /** Taker fee in basis points. */
  takerBps: number;
}

export interface SubmitResult {
  fills: Fill[];
  /** True if any size remained on the book as a resting order. */
  rested: boolean;
  /** Set when the order was refused (postOnly cross, FOK unfilled, reduceOnly no-op). */
  rejected?: string;
}

/** A normalized trade print from the recorded stream. `side` is the TAKER (aggressor) side. */
export interface MarketTrade {
  side: Side;
  price: number;
  size: number;
  ts: number;
}

export const EPS = 1e-9;
