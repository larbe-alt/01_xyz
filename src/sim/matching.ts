/**
 * MatchingEngine — the heart of the execution simulator.
 *
 * Two fill paths, both matching against the RECORDED market book/trades:
 *
 *  • Taker (market/ioc/fok/marketable-limit): walk the opposite side of the book
 *    best-first → VWAP fill across levels. Slippage is not a parameter; it emerges
 *    from real recorded depth. FOK kills if it can't fully fill within its limit;
 *    IOC/market discard the remainder.
 *
 *  • Maker (limit/postOnly that rests): the order joins the BACK of the queue at
 *    its price (queueAhead = displayed depth there). It only fills when recorded
 *    trades print at/through its price: incoming trade volume burns the queue ahead
 *    first, then fills us. Conservative — we never assume queue jumps.
 *
 * No look-ahead is a property of the RUN LOOP, not this class: the loop calls
 * onTrade() to settle resting fills for an event BEFORE dispatching that event to
 * the strategy, so an order placed in reaction to a trade can only fill on LATER
 * trades. The engine never lets a brand-new order fill on an already-processed print.
 *
 * The engine does NOT mutate the recorded book when our orders take liquidity:
 * orders are hypothetical and assumed small relative to displayed depth (standard
 * for size-limited backtests). Modeling our own market impact is a later refinement.
 */
import type { OrderBook } from "./book.js";
import type { Side, SimOrderIntent, Fill, RestingOrder, FeeModel, SubmitResult, MarketTrade } from "./types.js";
import { EPS } from "./types.js";

const EMPTY_FILLS: readonly Fill[] = Object.freeze([]);

export class MatchingEngine {
  private readonly resting = new Map<number, RestingOrder>();
  /** Net base position from our own fills (+long / -short); drives reduceOnly clamping. */
  private net = 0;
  /** Monotonic sequence so equal-price resting orders fill FIFO. */
  private seq = 0;
  private readonly seqOf = new Map<number, number>();

  constructor(
    private readonly book: OrderBook,
    private readonly fees: FeeModel,
  ) {}

  position(): number {
    return this.net;
  }

  open(): RestingOrder[] {
    return [...this.resting.values()];
  }

  cancel(cid: number): boolean {
    this.seqOf.delete(cid);
    return this.resting.delete(cid);
  }

  submit(o: SimOrderIntent, ts: number): SubmitResult {
    let size = o.size;

    if (o.reduceOnly) {
      const closable = o.side === "ask" ? Math.max(0, this.net) : Math.max(0, -this.net);
      size = Math.min(size, closable);
      if (size <= EPS) return { fills: [], rested: false, rejected: "reduceOnly: nothing to reduce" };
    }

    if (o.type === "market" || o.type === "ioc" || o.type === "fok") {
      const limit = o.type === "market" ? undefined : o.price;
      return this.take(o.cid, o.side, size, ts, o.type === "fok", limit);
    }

    // limit / postOnly
    if (o.price === undefined) return { fills: [], rested: false, rejected: "limit order needs a price" };
    const crosses = o.side === "bid" ? o.price >= this.book.bestAsk : o.price <= this.book.bestBid;

    if (o.type === "postOnly") {
      if (crosses) return { fills: [], rested: false, rejected: "postOnly would cross" };
      this.rest(o.cid, o.side, o.price, size, ts);
      return { fills: [], rested: true };
    }

    // plain limit: take the marketable part, rest the remainder
    let fills: Fill[] = [];
    if (crosses) {
      const r = this.take(o.cid, o.side, size, ts, false, o.price);
      fills = r.fills;
      size -= fills.reduce((s, f) => s + f.size, 0);
    }
    if (size > EPS) {
      this.rest(o.cid, o.side, o.price, size, ts);
      return { fills, rested: true };
    }
    return { fills, rested: false };
  }

  /**
   * Settle resting maker orders against a recorded print. `t.side` is the taker
   * (aggressor) side: a taker SELL (ask) hits our resting bids; a taker BUY fills
   * our resting asks.
   */
  onTrade(t: MarketTrade): readonly Fill[] {
    if (this.resting.size === 0) return EMPTY_FILLS;
    const makerSide: Side = t.side === "ask" ? "bid" : "ask";

    // Collect eligible resting orders without intermediate spread/filter
    const candidates: RestingOrder[] = [];
    for (const r of this.resting.values()) {
      if (r.side !== makerSide) continue;
      if (makerSide === "bid" ? r.price < t.price - EPS : r.price > t.price + EPS) continue;
      candidates.push(r);
    }
    if (candidates.length === 0) return EMPTY_FILLS;

    candidates.sort((a, b) =>
      a.price !== b.price
        ? makerSide === "bid"
          ? b.price - a.price
          : a.price - b.price
        : (this.seqOf.get(a.cid) ?? 0) - (this.seqOf.get(b.cid) ?? 0),
    );

    let vol = t.size;
    const fills: Fill[] = [];
    for (const r of candidates) {
      if (vol <= EPS) break;
      const burn = Math.min(r.queueAhead, vol);
      r.queueAhead -= burn;
      vol -= burn;
      if (vol <= EPS) break;
      const q = Math.min(r.remaining, vol);
      if (q <= EPS) continue;
      r.remaining -= q;
      vol -= q;
      const f = this.mkFill(r.cid, r.side, r.price, q, "maker", t.ts);
      fills.push(f);
      this.applyFill(f);
      if (r.remaining <= EPS) this.cancel(r.cid);
    }
    return fills;
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private take(cid: number, side: Side, size: number, ts: number, fok: boolean, limit?: number): SubmitResult {
    const levels = this.book.levels(side === "bid" ? "ask" : "bid");
    const fills: Fill[] = [];
    let rem = size;
    for (const [price, avail] of levels) {
      if (rem <= EPS) break;
      if (limit !== undefined) {
        if (side === "bid" && price > limit + EPS) break;
        if (side === "ask" && price < limit - EPS) break;
      }
      const q = Math.min(rem, avail);
      fills.push(this.mkFill(cid, side, price, q, "taker", ts));
      rem -= q;
    }
    if (fok && rem > EPS) return { fills: [], rested: false, rejected: "FOK: insufficient depth to fully fill" };
    for (const f of fills) this.applyFill(f);
    return { fills, rested: false };
  }

  private rest(cid: number, side: Side, price: number, size: number, ts: number): void {
    this.seqOf.set(cid, this.seq++);
    this.resting.set(cid, { cid, side, price, remaining: size, queueAhead: this.book.depthAt(side, price), ts });
  }

  private mkFill(cid: number, side: Side, price: number, size: number, liquidity: "maker" | "taker", ts: number): Fill {
    const bps = liquidity === "maker" ? this.fees.makerBps : this.fees.takerBps;
    return { cid, side, price, size, fee: (price * size * bps) / 10_000, liquidity, ts };
  }

  private applyFill(f: Fill): void {
    this.net += f.side === "bid" ? f.size : -f.size;
  }
}
