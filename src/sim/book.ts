/**
 * OrderBook — an L2 book reconstructed from recorded snapshots + signed deltas.
 *
 * Mirrors the incremental best-price maintenance used by the live LocalBook
 * (src/data/feed.ts): a top level is only rescanned when it is removed, so
 * applyDelta is O(1) on the common path even over hundreds of thousands of
 * updates.
 */
import type { Side } from "./types.js";
import { EPS } from "./types.js";

export function maxKey(m: Map<number, number>): number {
  let best = -Infinity;
  for (const k of m.keys()) if (k > best) best = k;
  return best;
}

export function minKey(m: Map<number, number>): number {
  let best = Infinity;
  for (const k of m.keys()) if (k < best) best = k;
  return best;
}

export class OrderBook {
  readonly bids = new Map<number, number>();
  readonly asks = new Map<number, number>();
  bestBid = -Infinity;
  bestAsk = Infinity;

  private bidLevels: [number, number][] | null = null;
  private askLevels: [number, number][] | null = null;

  private side(s: Side): Map<number, number> {
    return s === "bid" ? this.bids : this.asks;
  }

  /** Replace one level with an ABSOLUTE size (snapshot semantics). */
  setLevel(side: Side, price: number, size: number): void {
    const m = this.side(side);
    if (size <= EPS) m.delete(price);
    else m.set(price, size);
    if (side === "bid") this.bidLevels = null; else this.askLevels = null;
    this.refreshBest(side, price, size <= EPS);
  }

  /** Apply a SIGNED delta to a level (depth_update semantics; negative = removal). */
  applyDelta(side: Side, price: number, delta: number): void {
    const m = this.side(side);
    const next = (m.get(price) ?? 0) + delta;
    if (side === "bid") this.bidLevels = null; else this.askLevels = null;
    if (next <= EPS) {
      m.delete(price);
      this.refreshBest(side, price, true);
    } else {
      m.set(price, next);
      this.refreshBest(side, price, false);
    }
  }

  /** Re-establish best price; full rescan only when a top-of-book level was removed. */
  private refreshBest(side: Side, price: number, removed: boolean): void {
    if (side === "bid") {
      if (removed) {
        if (price >= this.bestBid) this.bestBid = this.bids.size ? maxKey(this.bids) : -Infinity;
      } else if (price > this.bestBid) {
        this.bestBid = price;
      }
    } else {
      if (removed) {
        if (price <= this.bestAsk) this.bestAsk = this.asks.size ? minKey(this.asks) : Infinity;
      } else if (price < this.bestAsk) {
        this.bestAsk = price;
      }
    }
  }

  clear(): void {
    this.bids.clear();
    this.asks.clear();
    this.bestBid = -Infinity;
    this.bestAsk = Infinity;
    this.bidLevels = null;
    this.askLevels = null;
  }

  depthAt(side: Side, price: number): number {
    return this.side(side).get(price) ?? 0;
  }

  /** Levels best-first: bids descending, asks ascending. Cached until next mutation. */
  levels(side: Side): [number, number][] {
    if (side === "bid") {
      if (!this.bidLevels) {
        this.bidLevels = [...this.bids.entries()];
        this.bidLevels.sort((a, b) => b[0] - a[0]);
      }
      return this.bidLevels;
    }
    if (!this.askLevels) {
      this.askLevels = [...this.asks.entries()];
      this.askLevels.sort((a, b) => a[0] - b[0]);
    }
    return this.askLevels;
  }

  mid(): number | null {
    if (this.bestBid === -Infinity || this.bestAsk === Infinity) return null;
    return (this.bestBid + this.bestAsk) / 2;
  }

  /** True when both sides exist and the top of book is crossed (a data/logic error). */
  crossed(): boolean {
    return this.bids.size > 0 && this.asks.size > 0 && this.bestBid >= this.bestAsk;
  }
}
