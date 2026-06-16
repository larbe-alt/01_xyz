import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import duckdb from "duckdb";
import type { AnyRecord, StreamType, TradeRecord, DeltaRecord, SnapshotRecord, CandleRecord, MarkRecord } from "./schema.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("replay");

function dbAll(db: duckdb.Database, sql: string): Promise<duckdb.TableData> {
  return new Promise((resolve, reject) => {
    db.all(sql, (err: Error | null, rows: duckdb.TableData) => (err ? reject(err) : resolve(rows)));
  });
}

export interface ReplayOptions {
  baseDir: string;
  env: string;
  markets: string[];
  streams: StreamType[];
  from?: number;
  to?: number;
  // playback speed multiplier: 1 = real-time, 10 = 10x, Infinity/omit = instant
  speed?: number;
}

export class ReplayFeed extends EventEmitter {
  private readonly opts: ReplayOptions;
  private aborted = false;

  constructor(opts: ReplayOptions) {
    super();
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.aborted = false;
    const { baseDir, env, markets, streams, from, to, speed } = this.opts;
    const db = new duckdb.Database(":memory:");

    const globs: string[] = [];
    for (const stream of streams) {
      for (const symbol of markets) {
        const dir = path.join(baseDir, env, stream, symbol);
        if (!existsSync(dir)) continue;
        globs.push(`'${dir.replace(/'/g, "''")}/*.parquet'`);
      }
    }

    if (globs.length === 0) {
      log.warn("No parquet files found", { baseDir, env, markets, streams });
      this.emit("connected");
      this.emit("disconnected");
      return;
    }

    let sql = `SELECT * FROM read_parquet([${globs.join(", ")}], union_by_name=true)`;
    const filters: string[] = [];
    if (from != null) filters.push(`ts >= ${from}`);
    if (to != null) filters.push(`ts <= ${to}`);
    if (filters.length) sql += ` WHERE ${filters.join(" AND ")}`;
    sql += ` ORDER BY ts, ts_local`;

    log.info("Replaying", { globs: globs.length, from, to, speed });
    this.emit("connected");

    let rows: duckdb.TableData;
    try {
      rows = await dbAll(db, sql);
    } catch (err) {
      log.error("Replay query failed", { error: err instanceof Error ? err.message : String(err) });
      this.emit("error", err);
      this.emit("disconnected");
      await closeDb(db);
      return;
    }

    log.info("Loaded records", { count: rows.length });

    let prevTs = 0;
    for (const raw of rows) {
      if (this.aborted) break;
      const row = raw as unknown as AnyRecord;

      if (speed != null && speed > 0 && speed !== Infinity && prevTs > 0) {
        const gap = (row.ts - prevTs) / speed;
        if (gap > 1) await sleep(gap);
      }
      prevTs = row.ts;

      this.dispatch(row);
    }

    this.emit("disconnected");
    await closeDb(db);
  }

  stop(): void {
    this.aborted = true;
  }

  private dispatch(row: AnyRecord): void {
    switch (row.stream) {
      case "trade":    this.emit("trade",    row as TradeRecord);    break;
      case "delta":    this.emit("delta",    row as DeltaRecord);    break;
      case "snapshot": this.emit("snapshot", row as SnapshotRecord); break;
      case "candle":   this.emit("candle",   row as CandleRecord);   break;
      case "mark":     this.emit("mark",     row as MarkRecord);     break;
    }
  }
}

function closeDb(db: duckdb.Database): Promise<void> {
  return new Promise((resolve) => db.close(() => resolve()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
