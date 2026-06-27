import { EventEmitter } from "node:events";
import type {
  Nord,
  CandleResolution,
  WebSocketTradeUpdate,
  WebSocketDeltaUpdate,
  WebSocketCandleUpdate,
  WebSocketAccountUpdate,
  WebSocketLiquidationUpdate,
  OrderbookInfo,
} from "@n1xyz/nord-ts";
import { createLogger } from "../utils/logger.js";
import { retry } from "../utils/retry.js";

const log = createLogger("feed");

export interface LocalBook {
  symbol: string;
  updateId: number;
  bids: Map<number, number>;
  asks: Map<number, number>;
  bestBid: number;
  bestAsk: number;
  synced: boolean;
  lastUpdateMs: number;
}

/** Max key without `Math.max(...map.keys())` — avoids the O(n) array spread allocation. */
export function maxKey(m: Map<number, number>): number {
  let max = -Infinity;
  for (const k of m.keys()) if (k > max) max = k;
  return max;
}

/** Min key without `Math.min(...map.keys())` — avoids the O(n) array spread allocation. */
export function minKey(m: Map<number, number>): number {
  let min = Infinity;
  for (const k of m.keys()) if (k < min) min = k;
  return min;
}

export interface FeedOptions {
  trades?: string[];
  deltas?: string[];
  accounts?: number[];
  candles?: { symbol: string; resolution: CandleResolution }[];
  liquidations?: boolean;
  livenessTimeoutMs?: number;
  livenessCheckMs?: number;
  maxReconnects?: number;
  baseReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

export class LiveFeed extends EventEmitter {
  private readonly nord: Nord;
  private readonly subs: Pick<FeedOptions, "trades" | "deltas" | "accounts" | "candles" | "liquidations">;
  private readonly livenessTimeoutMs: number;
  private readonly livenessCheckMs: number;
  private readonly maxReconnects: number;
  private readonly baseReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;

  private ws: any = null;
  // Per-stream last-activity. One shared timestamp would let a single still-
  // ticking stream (e.g. 1m candle bars) mask silent death of trades/deltas on
  // the same WS connection. Watchdog fails if ANY entry is stale.
  private readonly streamLastMs = new Map<string, number>();
  private readonly watchdogStreams: readonly string[];
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private reconnecting = false;
  private closed = false;
  private generation = 0;
  private readonly books = new Map<string, LocalBook>();
  private readonly deltaBuffers = new Map<string, WebSocketDeltaUpdate[]>();
  private readonly bookSyncing = new Set<string>();

  constructor(nord: Nord, opts: FeedOptions) {
    super();
    this.nord = nord;
    const { trades, deltas, accounts, candles, liquidations, ...cfg } = opts;
    this.subs = { trades, deltas, accounts, candles, liquidations };
    this.livenessTimeoutMs = cfg.livenessTimeoutMs ?? 15_000;
    this.livenessCheckMs = cfg.livenessCheckMs ?? 5_000;
    this.maxReconnects = cfg.maxReconnects ?? Infinity;
    this.baseReconnectDelayMs = cfg.baseReconnectDelayMs ?? 1_000;
    this.maxReconnectDelayMs = cfg.maxReconnectDelayMs ?? 30_000;

    // Only deltas gate the liveness watchdog. Deltas arrive continuously on any
    // active book (every order placement/cancel), so silence genuinely signals a
    // dead connection. Trades are episodic — quiet markets can go minutes without
    // a fill, so gating on trades would trigger false reconnects.
    const watchdog: string[] = [];
    if (deltas?.length) watchdog.push("deltas");
    this.watchdogStreams = watchdog;
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  close(): void {
    this.closed = true;
    this.stopLiveness();
    this.destroyWs();
    this.books.clear();
    this.deltaBuffers.clear();
    this.bookSyncing.clear();
    this.streamLastMs.clear();
    log.info("Feed closed");
  }

  getBook(symbol: string): LocalBook | null {
    const b = this.books.get(symbol);
    return b?.synced ? b : null;
  }

  getBestBid(symbol: string): number | null {
    const b = this.getBook(symbol);
    return b && b.bestBid !== -Infinity ? b.bestBid : null;
  }

  getBestAsk(symbol: string): number | null {
    const b = this.getBook(symbol);
    return b && b.bestAsk !== Infinity ? b.bestAsk : null;
  }

  getMid(symbol: string): number | null {
    const b = this.getBook(symbol);
    if (!b || b.bestBid === -Infinity || b.bestAsk === Infinity) return null;
    return (b.bestBid + b.bestAsk) / 2;
  }

  getSpread(symbol: string): number | null {
    const b = this.getBook(symbol);
    if (!b || b.bestBid === -Infinity || b.bestAsk === Infinity) return null;
    return b.bestAsk - b.bestBid;
  }

  getBids(symbol: string, depth?: number): [number, number][] {
    return this.levels(symbol, "bids", depth);
  }

  getAsks(symbol: string, depth?: number): [number, number][] {
    return this.levels(symbol, "asks", depth);
  }

  private levels(symbol: string, side: "bids" | "asks", depth?: number): [number, number][] {
    const book = this.getBook(symbol);
    if (!book) return [];
    const entries = [...book[side].entries()];
    entries.sort(side === "bids" ? (a, b) => b[0] - a[0] : (a, b) => a[0] - b[0]);
    return depth ? entries.slice(0, depth) : entries;
  }

  // -- connection lifecycle -------------------------------------------------

  private connect(): void {
    if (this.closed) return;
    log.info("Connecting", { subs: this.subs });

    try {
      const ws = this.nord.createWebSocketClient(this.subs);
      this.ws = ws;
      this.disableHeartbeat(ws);
      (ws as any).shouldReconnect = false;

      ws.on("connected", () => {
        log.info("Connected");
        this.reconnectAttempt = 0;
        this.reconnecting = false;
        // Seed each watchdogged stream so the timer doesn't trip before the
        // first message arrives on a fresh connection.
        const now = Date.now();
        for (const s of this.watchdogStreams) this.streamLastMs.set(s, now);
        this.startLiveness();
        this.emit("connected");
        for (const s of this.subs.deltas ?? []) this.syncBook(s);
      });

      ws.on("disconnected", () => {
        log.warn("Disconnected");
        this.stopLiveness();
        this.emit("disconnected");
        this.scheduleReconnect();
      });

      ws.on("error", (err: Error) => {
        log.error("WS error", { error: err.message });
        this.emit("error", err);
      });

      // SDK emits "trades" (plural) despite types declaring "trade"
      (ws as any).on("trades", (u: WebSocketTradeUpdate) => { this.touch("trades"); this.emit("trade", u); });
      ws.on("delta", (u: WebSocketDeltaUpdate) => { const now = Date.now(); this.streamLastMs.set("deltas", now); this.handleDelta(u, now); this.emit("delta", u); });
      ws.on("candle", (u: WebSocketCandleUpdate) => { this.touch("candles"); this.emit("candle", u); });
      ws.on("account", (u: WebSocketAccountUpdate) => { this.touch("accounts"); this.emit("account", u); });
      ws.on("liquidation", (u: WebSocketLiquidationUpdate) => { this.touch("liquidations"); this.emit("liquidation", u); });
    } catch (err) {
      log.error("Failed to create WS client", { error: err instanceof Error ? err.message : String(err) });
      this.scheduleReconnect();
    }
  }

  private touch(stream: string): void { this.streamLastMs.set(stream, Date.now()); }

  // Server kills WS-level pings (close 1011) — see scripts/ws/probe.py
  private disableHeartbeat(ws: any): void {
    if (ws.pingInterval != null) { clearInterval(ws.pingInterval); ws.pingInterval = null; }
    if (ws.pingTimeout != null) { clearTimeout(ws.pingTimeout); ws.pingTimeout = null; }
    if (typeof ws.setupHeartbeat === "function") ws.setupHeartbeat = () => {};
  }

  private startLiveness(): void {
    this.stopLiveness();
    if (this.watchdogStreams.length === 0) {
      log.warn("Liveness watchdog disabled (no fast streams subscribed)");
      return;
    }
    this.livenessTimer = setInterval(() => {
      const now = Date.now();
      for (const s of this.watchdogStreams) {
        const last = this.streamLastMs.get(s);
        if (last === undefined) continue;
        const silentMs = now - last;
        if (silentMs > this.livenessTimeoutMs) {
          log.warn("Liveness timeout", { stream: s, silentMs, thresholdMs: this.livenessTimeoutMs });
          this.destroyWs();
          this.scheduleReconnect();
          return;
        }
      }
    }, this.livenessCheckMs);
  }

  private stopLiveness(): void {
    if (this.livenessTimer != null) { clearInterval(this.livenessTimer); this.livenessTimer = null; }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    this.reconnectAttempt++;

    if (this.reconnectAttempt > this.maxReconnects) {
      log.error("Max reconnect attempts reached", { max: this.maxReconnects });
      this.emit("error", new Error(`Max reconnect attempts (${this.maxReconnects}) reached`));
      return;
    }

    const delay = Math.min(this.baseReconnectDelayMs * 2 ** (this.reconnectAttempt - 1), this.maxReconnectDelayMs);
    log.info("Reconnecting", { attempt: this.reconnectAttempt, delayMs: delay });
    this.emit("reconnecting", this.reconnectAttempt);

    setTimeout(() => {
      if (this.closed) return;
      // Release the in-flight guard as the scheduled attempt begins. If this
      // attempt fails before reaching "connected" (e.g. a sustained 502 storm),
      // scheduleReconnect() must be able to re-arm the next attempt. Without
      // this, `reconnecting` latches true forever and the feed dies silently
      // until manual restart — the 2026-06-26 22h WS-death outage.
      this.reconnecting = false;
      this.generation++;
      for (const book of this.books.values()) book.synced = false;
      this.deltaBuffers.clear();
      this.bookSyncing.clear();
      this.connect();
    }, delay);
  }

  private destroyWs(): void {
    if (!this.ws) return;
    this.stopLiveness();
    const ws = this.ws;
    this.ws = null;
    // Remove listeners before close so async error events after close don't propagate
    ws.removeAllListeners();
    ws.on("error", () => {});
    try {
      (ws as any).shouldReconnect = false;
      if ((ws as any).reconnectTimeout != null) { clearTimeout((ws as any).reconnectTimeout); (ws as any).reconnectTimeout = null; }
      ws.close();
    } catch { /* ignore */ }
  }

  // -- orderbook management -------------------------------------------------

  private handleDelta(update: WebSocketDeltaUpdate, nowMs: number): void {
    const symbol = update.market_symbol;
    if (!symbol) return;
    const book = this.books.get(symbol);

    if (!book || !book.synced) { this.bufferDelta(symbol, update); return; }

    if (update.last_update_id !== book.updateId) {
      if (update.last_update_id === 0 && update.update_id > book.updateId) {
        this.applyDelta(book, update, nowMs);
        this.emit("book", symbol, book);
        return;
      }
      log.warn("Book gap, resyncing", { symbol, expected: book.updateId, got: update.last_update_id });
      book.synced = false;
      this.bufferDelta(symbol, update);
      this.syncBook(symbol);
      return;
    }

    this.applyDelta(book, update, nowMs);
    this.emit("book", symbol, book);
  }

  private bufferDelta(symbol: string, delta: WebSocketDeltaUpdate): void {
    let buf = this.deltaBuffers.get(symbol);
    if (!buf) { buf = []; this.deltaBuffers.set(symbol, buf); }
    if (buf.length >= 500) buf.splice(0, 100);
    buf.push(delta);
  }

  private applyDelta(book: LocalBook, delta: WebSocketDeltaUpdate, nowMs: number): void {
    let bidDirty = false, askDirty = false;
    for (const [p, s] of delta.bids) {
      if (s === 0) { book.bids.delete(p); if (p >= book.bestBid) bidDirty = true; }
      else { book.bids.set(p, s); if (p > book.bestBid) { book.bestBid = p; bidDirty = false; } }
    }
    for (const [p, s] of delta.asks) {
      if (s === 0) { book.asks.delete(p); if (p <= book.bestAsk) askDirty = true; }
      else { book.asks.set(p, s); if (p < book.bestAsk) { book.bestAsk = p; askDirty = false; } }
    }
    if (bidDirty) book.bestBid = book.bids.size ? maxKey(book.bids) : -Infinity;
    if (askDirty) book.bestAsk = book.asks.size ? minKey(book.asks) : Infinity;
    book.updateId = delta.update_id;
    book.lastUpdateMs = nowMs;
  }

  private async syncBook(symbol: string): Promise<void> {
    if (this.bookSyncing.has(symbol)) return;
    this.bookSyncing.add(symbol);
    const gen = this.generation;
    const slog = log.child({ symbol });
    slog.info("Syncing orderbook");

    try {
      const snap: OrderbookInfo = await retry(
        () => this.nord.getOrderbook({ symbol }),
        { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 5_000 },
      );
      if (this.closed || gen !== this.generation) return;

      const now = Date.now();
      const bidMap = new Map(snap.bids.map(([p, s]) => [p, s]));
      const askMap = new Map(snap.asks.map(([p, s]) => [p, s]));
      const book: LocalBook = {
        symbol, updateId: snap.updateId, synced: false, lastUpdateMs: now,
        bids: bidMap, asks: askMap,
        bestBid: bidMap.size ? maxKey(bidMap) : -Infinity,
        bestAsk: askMap.size ? minKey(askMap) : Infinity,
      };

      let applied = 0;
      for (const d of this.deltaBuffers.get(symbol) ?? []) {
        if (d.update_id <= snap.updateId || d.last_update_id !== book.updateId) continue;
        this.applyDelta(book, d, now);
        applied++;
      }

      book.synced = true;
      this.books.set(symbol, book);
      this.deltaBuffers.delete(symbol);
      slog.info("Book synced", { updateId: book.updateId, bids: book.bids.size, asks: book.asks.size, bufferedApplied: applied });
      this.emit("book", symbol, book);
    } catch (err) {
      slog.error("Book sync failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.bookSyncing.delete(symbol);
    }
  }
}
