/**
 * FeedSource — a unified streaming surface over the live WS feed and the replay
 * reader. Both implementations emit the SAME normalized events so a strategy
 * runs identically on live or recorded data:
 *
 *   "trade"   (FeedTrade)
 *   "book"    (symbol: string, LocalBook)
 *   "candle"  (FeedCandle)
 *   "account" (WebSocketAccountUpdate)   — live only
 *   "connected" / "disconnected" / "reconnecting" / "error"
 *
 * LiveFeed already maintains a LocalBook from deltas; on replay we rebuild the
 * book from recorded delta/snapshot rows so getBook()/getMid() work there too.
 */
import { EventEmitter } from "node:events";
import type { WebSocketTradeUpdate, WebSocketCandleUpdate, WebSocketAccountUpdate } from "@n1xyz/nord-ts";
import { LiveFeed, maxKey, minKey, type LocalBook } from "./feed.js";
import { ReplayFeed } from "./recorder/replay.js";
import type { TradeRecord, DeltaRecord, SnapshotRecord, CandleRecord } from "./recorder/schema.js";
import { idToSymbol } from "../registry/markets.js";
import type { FeedTrade, FeedCandle } from "../engine/types.js";

export interface FeedSource extends EventEmitter {
  start(): Promise<void> | void;
  stop(): void;
  getBook(symbol: string): LocalBook | null;
  getMid(symbol: string): number | null;
  getBestBid(symbol: string): number | null;
  getBestAsk(symbol: string): number | null;
}

// ── Live ──────────────────────────────────────────────────────────────────────

export class LiveFeedSource extends EventEmitter implements FeedSource {
  constructor(private readonly feed: LiveFeed) {
    super();
    feed.on("connected", () => this.emit("connected"));
    feed.on("disconnected", () => this.emit("disconnected"));
    feed.on("reconnecting", (n: number) => this.emit("reconnecting", n));
    feed.on("error", (e: Error) => this.emit("error", e));

    feed.on("trade", (u: WebSocketTradeUpdate) => {
      for (const t of u.trades) {
        const ft: FeedTrade = {
          symbol: u.market_symbol,
          price: t.price,
          size: t.size,
          side: String(t.side),
          tradeId: t.trade_id,
          ts: Date.parse(t.physical_time) || 0,
        };
        this.emit("trade", ft);
      }
    });

    feed.on("book", (symbol: string, book: LocalBook) => this.emit("book", symbol, book));

    feed.on("candle", (u: WebSocketCandleUpdate) => {
      // idToSymbol throws on an unknown market id; this runs inside the WS callback,
      // so swallow it and drop the candle rather than crash the socket handler.
      let symbol: string;
      try {
        symbol = idToSymbol(u.mid);
      } catch {
        return;
      }
      const fc: FeedCandle = {
        symbol,
        resolution: String(u.res),
        open: u.o,
        high: u.h,
        low: u.l,
        close: u.c,
        volume: u.v,
        openTime: u.t,
      };
      this.emit("candle", fc);
    });

    feed.on("account", (u: WebSocketAccountUpdate) => this.emit("account", u));
  }

  start(): void {
    this.feed.start();
  }
  stop(): void {
    this.feed.close();
  }
  getBook(symbol: string): LocalBook | null {
    return this.feed.getBook(symbol);
  }
  getMid(symbol: string): number | null {
    return this.feed.getMid(symbol);
  }
  getBestBid(symbol: string): number | null {
    return this.feed.getBestBid(symbol);
  }
  getBestAsk(symbol: string): number | null {
    return this.feed.getBestAsk(symbol);
  }
}

// ── Replay ────────────────────────────────────────────────────────────────────

export class ReplayFeedSource extends EventEmitter implements FeedSource {
  private readonly books = new Map<string, LocalBook>();

  constructor(private readonly feed: ReplayFeed) {
    super();
    feed.on("connected", () => this.emit("connected"));
    feed.on("disconnected", () => this.emit("disconnected"));
    feed.on("error", (e: unknown) => this.emit("error", e));

    feed.on("trade", (r: TradeRecord) => {
      const ft: FeedTrade = {
        symbol: r.symbol,
        price: r.price,
        size: r.size,
        side: r.side,
        tradeId: r.trade_id,
        ts: r.ts,
      };
      this.emit("trade", ft);
    });

    feed.on("snapshot", (r: SnapshotRecord) => {
      const book = this.books.get(r.symbol) ?? emptyBook(r.symbol);
      setSnapshot(book, parseLevels(r.bids), parseLevels(r.asks), r.update_id, r.ts);
      this.books.set(r.symbol, book);
      this.emit("book", r.symbol, book);
    });

    feed.on("delta", (r: DeltaRecord) => {
      const book = this.books.get(r.symbol);
      // A delta can only be applied on top of a snapshot base. Without one (e.g. a
      // mid-stream replay window) the book stays unsynced → getMid() returns null →
      // the risk guard refuses to mark-price the order rather than using a wrong book.
      if (!book || !book.synced) return;
      applyDelta(book, parseLevels(r.bids), parseLevels(r.asks), r.update_id, r.ts);
      this.emit("book", r.symbol, book);
    });

    feed.on("candle", (r: CandleRecord) => {
      const fc: FeedCandle = {
        symbol: r.symbol,
        resolution: r.resolution,
        open: r.o,
        high: r.h,
        low: r.l,
        close: r.c,
        volume: r.vol,
        openTime: r.ts,
      };
      this.emit("candle", fc);
    });
  }

  start(): Promise<void> {
    return this.feed.start();
  }
  stop(): void {
    this.feed.stop();
  }
  getBook(symbol: string): LocalBook | null {
    const b = this.books.get(symbol);
    return b?.synced ? b : null;
  }
  getMid(symbol: string): number | null {
    const b = this.books.get(symbol);
    if (!b || b.bestBid === -Infinity || b.bestAsk === Infinity) return null;
    return (b.bestBid + b.bestAsk) / 2;
  }
  getBestBid(symbol: string): number | null {
    const b = this.books.get(symbol);
    return b && b.bestBid !== -Infinity ? b.bestBid : null;
  }
  getBestAsk(symbol: string): number | null {
    const b = this.books.get(symbol);
    return b && b.bestAsk !== Infinity ? b.bestAsk : null;
  }
}

// ── Book reconstruction helpers (replay) ──────────────────────────────────────

function emptyBook(symbol: string): LocalBook {
  return {
    symbol,
    updateId: 0,
    bids: new Map<number, number>(),
    asks: new Map<number, number>(),
    bestBid: -Infinity,
    bestAsk: Infinity,
    synced: false,
    lastUpdateMs: 0,
  };
}

function parseLevels(s: string): [number, number][] {
  try {
    return JSON.parse(s) as [number, number][];
  } catch {
    return [];
  }
}

/** Replace the whole book from a snapshot; only a snapshot may set `synced`. */
function setSnapshot(
  book: LocalBook,
  bids: [number, number][],
  asks: [number, number][],
  updateId: number,
  ts: number,
): void {
  book.bids.clear();
  book.asks.clear();
  for (const [p, sz] of bids) if (sz !== 0) book.bids.set(p, sz);
  for (const [p, sz] of asks) if (sz !== 0) book.asks.set(p, sz);
  book.bestBid = book.bids.size ? maxKey(book.bids) : -Infinity;
  book.bestAsk = book.asks.size ? minKey(book.asks) : Infinity;
  book.updateId = updateId;
  book.lastUpdateMs = ts;
  book.synced = true;
}

/** Apply an incremental delta; best-price only recomputed when a top level is removed. */
function applyDelta(
  book: LocalBook,
  bids: [number, number][],
  asks: [number, number][],
  updateId: number,
  ts: number,
): void {
  let bidDirty = false;
  let askDirty = false;
  for (const [p, sz] of bids) {
    if (sz === 0) {
      book.bids.delete(p);
      if (p >= book.bestBid) bidDirty = true;
    } else {
      book.bids.set(p, sz);
      if (p > book.bestBid) book.bestBid = p;
    }
  }
  for (const [p, sz] of asks) {
    if (sz === 0) {
      book.asks.delete(p);
      if (p <= book.bestAsk) askDirty = true;
    } else {
      book.asks.set(p, sz);
      if (p < book.bestAsk) book.bestAsk = p;
    }
  }
  if (bidDirty) book.bestBid = book.bids.size ? maxKey(book.bids) : -Infinity;
  if (askDirty) book.bestAsk = book.asks.size ? minKey(book.asks) : Infinity;
  book.updateId = updateId;
  book.lastUpdateMs = ts;
}
