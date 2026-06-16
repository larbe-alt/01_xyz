import { EventEmitter } from "node:events";
import type { FeedSource } from "../data/feed-source.js";
import type { LocalBook } from "../data/feed.js";
import type { OrderBook } from "../sim/book.js";

/**
 * SimFeedSource — wraps the sim OrderBooks so strategies see a FeedSource
 * without duplicating any Map state. The runner updates the OrderBook via
 * setLevel(); call sync() afterward to refresh the lightweight metadata
 * (bestBid/bestAsk/updateId/ts) that LocalBook carries.
 */
export class SimFeedSource extends EventEmitter implements FeedSource {
  private readonly entries = new Map<string, { book: OrderBook; lb: LocalBook }>();

  start(): void {}
  stop(): void {}

  /** Register a sim OrderBook. Call once per market before the event loop. */
  addBook(symbol: string, book: OrderBook): void {
    this.entries.set(symbol, {
      book,
      lb: {
        symbol,
        updateId: 0,
        bids: book.bids,
        asks: book.asks,
        bestBid: -Infinity,
        bestAsk: Infinity,
        synced: false,
        lastUpdateMs: 0,
      },
    });
  }

  /** Copy bestBid/bestAsk from the OrderBook and bump the update counter. */
  sync(symbol: string, ts: number): void {
    const e = this.entries.get(symbol);
    if (!e) return;
    e.lb.bestBid = e.book.bestBid;
    e.lb.bestAsk = e.book.bestAsk;
    e.lb.lastUpdateMs = ts;
    e.lb.updateId++;
    e.lb.synced = true;
  }

  getBook(symbol: string): LocalBook | null {
    const e = this.entries.get(symbol);
    return e?.lb.synced ? e.lb : null;
  }

  getMid(symbol: string): number | null {
    const e = this.entries.get(symbol);
    if (!e) return null;
    const { bestBid, bestAsk } = e.book;
    if (bestBid === -Infinity || bestAsk === Infinity) return null;
    return (bestBid + bestAsk) / 2;
  }

  getBestBid(symbol: string): number | null {
    const e = this.entries.get(symbol);
    return e && e.book.bestBid !== -Infinity ? e.book.bestBid : null;
  }

  getBestAsk(symbol: string): number | null {
    const e = this.entries.get(symbol);
    return e && e.book.bestAsk !== Infinity ? e.book.bestAsk : null;
  }
}
