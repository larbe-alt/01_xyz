import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import duckdb from "duckdb";
import type { AnyRecord, StreamType } from "./schema.js";
import { DUCKDB_COLUMNS } from "./schema.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("writer");

function dbExec(db: duckdb.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

export interface WriterOptions {
  baseDir: string;
  env: string;
  rotationMs?: number;
  maxBufferSize?: number;
}

function utcTag(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}`
  );
}

export class ParquetWriter {
  private readonly stream: StreamType;
  private readonly symbol: string;
  private readonly outDir: string;
  private readonly db: duckdb.Database;
  private readonly rotationMs: number;
  private readonly maxBufferSize: number;
  private buffer: AnyRecord[] = [];
  private windowStart = 0;
  private rotationTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private closed = false;
  readonly log;

  totalRecords = 0;
  totalFlushes = 0;

  constructor(stream: StreamType, symbol: string, db: duckdb.Database, opts: WriterOptions) {
    this.stream = stream;
    this.symbol = symbol;
    this.db = db;
    this.outDir = path.join(opts.baseDir, opts.env, stream, symbol);
    this.rotationMs = opts.rotationMs ?? 5 * 60_000;
    this.maxBufferSize = opts.maxBufferSize ?? 100_000;
    this.log = log.child({ stream, symbol });

    mkdirSync(this.outDir, { recursive: true });
  }

  start(): void {
    this.windowStart = Date.now();
    this.rotationTimer = setInterval(() => {
      this.rotate().catch((err) => this.log.error("Rotation failed", { error: String(err) }));
    }, this.rotationMs);
  }

  append(record: AnyRecord): void {
    if (this.closed) return;
    this.buffer.push(record);
    if (this.buffer.length >= this.maxBufferSize) {
      this.rotate().catch((err) => this.log.error("Forced rotation failed", { error: String(err) }));
    }
  }

  async rotate(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const records = this.buffer;
    const windowStart = this.windowStart;
    this.buffer = [];
    this.windowStart = Date.now();
    try {
      await this.writeParquet(records, windowStart);
      this.totalFlushes++;
    } finally {
      this.flushing = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
    await this.rotate();
  }

  private async writeParquet(records: AnyRecord[], windowStartMs: number): Promise<void> {
    const tag = utcTag(windowStartMs);
    const outPath = path.join(this.outDir, `${tag}.parquet`);
    const tmpPath = outPath + ".tmp.ndjson";

    const ndjson = records.map((r) => JSON.stringify(r)).join("\n");
    writeFileSync(tmpPath, ndjson);

    const cols = DUCKDB_COLUMNS[this.stream];
    const sql = `COPY (
      SELECT * FROM read_json(
        '${tmpPath.replace(/'/g, "''")}',
        format = 'newline_delimited',
        columns = ${cols}
      ) ORDER BY ts
    ) TO '${outPath.replace(/'/g, "''")}' (FORMAT PARQUET, COMPRESSION 'zstd')`;

    try {
      await dbExec(this.db, sql);
      this.totalRecords += records.length;
      this.log.info("Parquet written", {
        file: `${tag}.parquet`,
        records: records.length,
        totalRecords: this.totalRecords,
      });
    } finally {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
}

let _sharedDb: duckdb.Database | null = null;

export function getSharedDb(): duckdb.Database {
  if (!_sharedDb) _sharedDb = new duckdb.Database(":memory:");
  return _sharedDb;
}

export function closeSharedDb(): Promise<void> {
  return new Promise((resolve) => {
    if (_sharedDb) {
      _sharedDb.close(() => { _sharedDb = null; resolve(); });
    } else {
      resolve();
    }
  });
}
