/**
 * PnLEngine — records an equity curve, trade log, and funding on top of SimState.
 *
 * SimState does the math (positions, realized/unrealized PnL, equity).
 * PnLEngine wraps it and captures time-series data the metrics calculator needs:
 *   1. Equity curve — sampled on every fill, mark, and funding event.
 *   2. Trade log — one record per fill with attributed realized PnL + slippage.
 *   3. Funding log — one record per funding accrual.
 *   4. Running stats — max position, total notional, exposure time.
 *
 * The backtest driver calls onFills() for maker fills from engine.onTrade()
 * and taker fills from gateway.place(), onMark() on each trade event, and
 * onFunding() at each funding interval.
 */
import type { SimState } from "../sim/adapters.js";
import type { Fill } from "../sim/types.js";

export interface EquitySample {
  ts: number;
  equity: number;
}

export interface TradeRecord {
  ts: number;
  symbol: string;
  side: "bid" | "ask";
  price: number;
  size: number;
  fee: number;
  liquidity: "maker" | "taker";
  realizedPnl: number;
  positionAfter: number;
  entryPriceAfter: number;
  /** Fill price minus mid at fill time; positive = adverse for the filler. */
  slippage: number;
  /** Mid price at the moment of fill (NaN if no mid was set yet). */
  midAtFill: number;
}

export interface FundingRecord {
  ts: number;
  symbol: string;
  rate: number;
  payment: number;
  positionSize: number;
  markPrice: number;
}

export class PnLEngine {
  private readonly curve: EquitySample[] = [];
  private readonly tradeLog: TradeRecord[] = [];
  private readonly fundingLog: FundingRecord[] = [];
  private readonly mids = new Map<string, number>();
  private totalNotional = 0;
  private maxAbsPos = 0;
  private positionMs = 0;
  private totalFunding = 0;
  private lastTs = 0;
  private lastHadPos = false;
  private lastCurveTs = -Infinity;
  /** Minimum ms between equity curve samples (0 = sample everything). */
  private readonly curveMinIntervalMs: number;

  constructor(private readonly state: SimState, curveMinIntervalMs = 0) {
    this.curveMinIntervalMs = curveMinIntervalMs;
  }

  /**
   * Process fills — typically called once per trade event with the maker fills
   * from engine.onTrade(), or by SimOrderGateway after a taker fill.
   * The caller must NOT also call state.applyFills() — this method does it.
   */
  onFills(fills: readonly Fill[], symbol: string, marketId: number, ts: number): void {
    for (const f of fills) {
      const before = this.state.positionGet(symbol);
      const prevSigned = before ? (before.isLong ? 1 : -1) * Number(before.baseSize) : 0;
      const prevEntry = before ? Number(before.entryPrice) : 0;

      this.state.applyFills([f], symbol, marketId);

      const after = this.state.positionGet(symbol);
      const nextSigned = after ? (after.isLong ? 1 : -1) * Number(after.baseSize) : 0;

      const delta = f.side === "bid" ? f.size : -f.size;
      let realizedPnl = 0;
      if (prevSigned !== 0 && Math.sign(delta) !== Math.sign(prevSigned)) {
        const reduced = Math.min(f.size, Math.abs(prevSigned));
        realizedPnl = (f.price - prevEntry) * reduced * Math.sign(prevSigned);
      }

      const mid = this.mids.get(symbol) ?? NaN;
      const slippage = Number.isNaN(mid)
        ? 0
        : f.side === "bid"
          ? f.price - mid
          : mid - f.price;

      this.tradeLog.push({
        ts,
        symbol,
        side: f.side,
        price: f.price,
        size: f.size,
        fee: f.fee,
        liquidity: f.liquidity,
        realizedPnl,
        positionAfter: nextSigned,
        entryPriceAfter: after ? Number(after.entryPrice) : 0,
        slippage,
        midAtFill: mid,
      });

      this.totalNotional += f.price * f.size;
      const absPos = Math.abs(nextSigned);
      if (absPos > this.maxAbsPos) this.maxAbsPos = absPos;
    }

    this.tickExposure(ts);
    this.sampleCurve(ts, true);
  }

  /**
   * Update mark price and sample equity. Call on each trade event so the
   * equity curve reflects mark-to-market movements between fills.
   */
  onMark(symbol: string, price: number, ts: number): void {
    this.mids.set(symbol, price);
    this.state.setMark(symbol, price);
    this.tickExposure(ts);
    this.sampleCurve(ts, false);
  }

  /**
   * Accrue a funding payment. payment = rate × signedPosition × markPrice.
   * Positive rate means longs pay shorts; the sign of the payment follows
   * the convention: positive = we paid, negative = we received.
   */
  onFunding(symbol: string, rate: number, ts: number): void {
    const pos = this.state.positionGet(symbol);
    if (!pos || Number(pos.baseSize) < 1e-12) return;

    const signed = pos.isLong ? Number(pos.baseSize) : -Number(pos.baseSize);
    const mark = this.mids.get(symbol) ?? Number(pos.entryPrice);
    const payment = rate * signed * mark;

    this.totalFunding += payment;
    this.fundingLog.push({ ts, symbol, rate, payment, positionSize: signed, markPrice: mark });

    this.tickExposure(ts);
    this.sampleCurve(ts, true);
  }

  equityCurve(): readonly EquitySample[] {
    return this.curve;
  }

  trades(): readonly TradeRecord[] {
    return this.tradeLog;
  }

  funding(): readonly FundingRecord[] {
    return this.fundingLog;
  }

  stats() {
    return {
      initialEquity: this.state.initialEquity,
      finalEquity: this.state.equity() - this.totalFunding,
      totalNotional: this.totalNotional,
      maxAbsPosition: this.maxAbsPos,
      exposureMs: this.positionMs,
      totalDurationMs: this.lastTs > 0 ? this.lastTs - (this.curve[0]?.ts ?? this.lastTs) : 0,
      totalFunding: this.totalFunding,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private sampleCurve(ts: number, force: boolean): void {
    if (!force && this.curveMinIntervalMs > 0 && ts - this.lastCurveTs < this.curveMinIntervalMs) return;
    this.curve.push({ ts, equity: this.state.equity() });
    this.lastCurveTs = ts;
  }

  private tickExposure(ts: number): void {
    if (this.lastTs > 0 && this.lastHadPos) {
      this.positionMs += ts - this.lastTs;
    }
    this.lastTs = ts;
    this.lastHadPos = this.state.positionList().length > 0;
  }
}
