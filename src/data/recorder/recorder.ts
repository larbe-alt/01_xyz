import type { Nord, WebSocketTradeUpdate, WebSocketDeltaUpdate, WebSocketCandleUpdate } from "@n1xyz/nord-ts";
import type { LiveFeed, LocalBook } from "../feed.js";
import { byId, symbolToId } from "../../registry/markets.js";
import { createLogger } from "../../utils/logger.js";
import { ParquetWriter, getSharedDb, type WriterOptions } from "./writers.js";
import {
  SCHEMA_VERSION,
  type StreamType,
  type TradeRecord,
  type DeltaRecord,
  type SnapshotRecord,
  type CandleRecord,
  type MarkRecord,
} from "./schema.js";

const log = createLogger("recorder");

export interface RecorderOptions {
  markets: string[];
  streams: StreamType[];
  baseDir: string;
  env: string;
  rotationMs?: number;
  markPollMs?: number;
  snapshotIntervalMs?: number;
  snapshotDepth?: number;
}

export class Recorder {
  private readonly nord: Nord;
  private readonly feed: LiveFeed;
  private readonly opts: RecorderOptions;
  private readonly writers = new Map<string, ParquetWriter>();
  private readonly marketSet: Set<string>;
  private readonly streamSet: Set<StreamType>;
  private markTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(nord: Nord, feed: LiveFeed, opts: RecorderOptions) {
    this.nord = nord;
    this.feed = feed;
    this.opts = opts;
    this.marketSet = new Set(opts.markets);
    this.streamSet = new Set(opts.streams);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    log.info("Starting recorder", { markets: this.opts.markets, streams: this.opts.streams });

    if (this.streamSet.has("trade")) {
      this.feed.on("trade", this.onTrade);
    }
    if (this.streamSet.has("delta")) {
      this.feed.on("delta", this.onDelta);
    }
    // snapshot needs deltas to build the local book, but we don't record the deltas themselves
    if (this.streamSet.has("snapshot") && !this.streamSet.has("delta")) {
      this.feed.on("delta", this.onDelta);
    }
    if (this.streamSet.has("candle")) {
      this.feed.on("candle", this.onCandle);
    }

    if (this.streamSet.has("snapshot")) {
      const interval = this.opts.snapshotIntervalMs ?? 60_000;
      this.snapshotTimer = setInterval(() => this.takeSnapshots(), interval);
    }

    if (this.streamSet.has("mark")) {
      const interval = this.opts.markPollMs ?? 10_000;
      this.pollMarks();
      this.markTimer = setInterval(() => this.pollMarks(), interval);
    }

    this.statsTimer = setInterval(() => this.logStats(), 30_000);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    log.info("Stopping recorder");

    this.feed.off("trade", this.onTrade);
    this.feed.off("delta", this.onDelta);
    this.feed.off("candle", this.onCandle);

    if (this.markTimer) { clearInterval(this.markTimer); this.markTimer = null; }
    if (this.snapshotTimer) { clearInterval(this.snapshotTimer); this.snapshotTimer = null; }
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }

    await Promise.all([...this.writers.values()].map((w) => w.close()));
    log.info("Recorder stopped, all writers flushed");
  }

  private getWriter(stream: StreamType, symbol: string): ParquetWriter {
    const key = `${stream}:${symbol}`;
    let w = this.writers.get(key);
    if (!w) {
      const writerOpts: WriterOptions = {
        baseDir: this.opts.baseDir,
        env: this.opts.env,
        rotationMs: this.opts.rotationMs,
      };
      w = new ParquetWriter(stream, symbol, getSharedDb(), writerOpts);
      w.start();
      this.writers.set(key, w);
    }
    return w;
  }

  private readonly onTrade = (update: WebSocketTradeUpdate): void => {
    const symbol = update.market_symbol;
    if (!symbol || !this.marketSet.has(symbol)) return;
    const now = Date.now();
    const marketId = symbolToId(symbol);

    for (const t of update.trades) {
      const record: TradeRecord = {
        v: SCHEMA_VERSION,
        stream: "trade",
        symbol,
        market_id: marketId,
        ts: new Date(t.physical_time).getTime(),
        ts_local: now,
        trade_id: t.trade_id,
        action_id: t.action_id,
        side: t.side,
        price: t.price,
        size: t.size,
      };
      this.getWriter("trade", symbol).append(record);
    }
  };

  private readonly onDelta = (update: WebSocketDeltaUpdate): void => {
    const symbol = update.market_symbol;
    if (!symbol || !this.marketSet.has(symbol)) return;

    if (!this.streamSet.has("delta")) return;

    const now = Date.now();
    const record: DeltaRecord = {
      v: SCHEMA_VERSION,
      stream: "delta",
      symbol,
      market_id: symbolToId(symbol),
      ts: now,
      ts_local: now,
      update_id: update.update_id,
      last_update_id: update.last_update_id,
      bids: JSON.stringify(update.bids),
      asks: JSON.stringify(update.asks),
    };
    this.getWriter("delta", symbol).append(record);
  };

  private readonly onCandle = (update: WebSocketCandleUpdate): void => {
    let meta;
    try { meta = byId(update.mid); } catch { return; }
    if (!this.marketSet.has(meta.symbol)) return;

    const now = Date.now();
    const record: CandleRecord = {
      v: SCHEMA_VERSION,
      stream: "candle",
      symbol: meta.symbol,
      market_id: update.mid,
      ts: update.t * 1000,
      ts_local: now,
      resolution: update.res,
      o: update.o,
      h: update.h,
      l: update.l,
      c: update.c,
      vol: update.v,
    };
    this.getWriter("candle", meta.symbol).append(record);
  };

  private pollMarks(): void {
    this.nord.getMarketsLive().then((data) => {
      const now = Date.now();
      for (const m of data.markets) {
        let meta;
        try { meta = byId(m.marketId); } catch { continue; }
        if (!this.marketSet.has(meta.symbol)) continue;

        const record: MarkRecord = {
          v: SCHEMA_VERSION,
          stream: "mark",
          symbol: meta.symbol,
          market_id: m.marketId,
          ts: now,
          ts_local: now,
          index_price: m.indexPrice ?? null,
          mark_price: m.perpetuals?.markPrice ?? null,
          funding_rate: m.perpetuals?.projectedFundingRate ?? null,
          next_funding_time: m.perpetuals?.nextFundingTime ?? null,
          open_interest: m.perpetuals?.openInterest ?? 0,
        };
        this.getWriter("mark", meta.symbol).append(record);
      }
    }).catch((err) => {
      log.error("Mark poll failed", { error: err instanceof Error ? err.message : String(err) });
    });
  }

  private takeSnapshots(): void {
    const now = Date.now();
    const depth = this.opts.snapshotDepth ?? 50;

    for (const symbol of this.marketSet) {
      const book: LocalBook | null = this.feed.getBook(symbol);
      if (!book?.synced) continue;

      const bids = [...book.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, depth);
      const asks = [...book.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, depth);

      const record: SnapshotRecord = {
        v: SCHEMA_VERSION,
        stream: "snapshot",
        symbol,
        market_id: symbolToId(symbol),
        ts: now,
        ts_local: now,
        update_id: book.updateId,
        bids: JSON.stringify(bids),
        asks: JSON.stringify(asks),
      };
      this.getWriter("snapshot", symbol).append(record);
    }
  }

  private logStats(): void {
    for (const [key, w] of this.writers) {
      log.info("Writer stats", { key, records: w.totalRecords, flushes: w.totalFlushes });
    }
  }
}
