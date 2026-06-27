/**
 * Native 01 loader — reads THIS repo's own recorder schema (src/data/recorder/schema.ts)
 * as written live on the VPS by `recorder01` to data/<env>/<stream>/<SYMBOL>/*.parquet.
 *
 * Unlike the fuel_o2 archive, values are already in real units (no 1e9 scaling),
 * trade `side` is "bid"/"ask", and book levels are JSON arrays [[price,size],…].
 * Crucially, delta rows carry the ABSOLUTE new size at each level (size 0 = remove),
 * matching the live LocalBook semantics (src/data/feed.ts) — so we setLevel(), not
 * add a signed increment.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import duckdb from "duckdb";
import type { Side, MarketTrade } from "../types.js";

export type Native01Event =
  | { kind: "snapshot"; ts: number; bids: [number, number][]; asks: [number, number][] }
  | { kind: "delta"; ts: number; bids: [number, number][]; asks: [number, number][] }
  | { kind: "trade"; ts: number; trade: MarketTrade };

export interface LoadOptions {
  dir: string; // baseDir, e.g. "data"
  env: string; // "mainnet" | "devnet"
  market: string; // "ETHUSD"
  /** If set, skip parquet files that are wholly before this timestamp (ms). */
  fromMs?: number;
  /** If set, skip parquet files that start after this timestamp (ms). */
  toMs?: number;
}

const BUCKET_MS = 5 * 60 * 1000;
const FNAME_RE = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})\.parquet$/;

function fileStartMs(fname: string): number | null {
  const m = FNAME_RE.exec(fname);
  if (!m) return null;
  return Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`);
}

/** Return sorted list of parquet files whose 5-min bucket overlaps [fromMs-padMs, toMs]. */
function filterFiles(dir: string, fromMs: number | undefined, toMs: number | undefined, padMs = 0): string[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".parquet"))
    .sort();
  if (fromMs == null && toMs == null) return files.map((f) => path.join(dir, f));
  return files
    .filter((f) => {
      const t = fileStartMs(f);
      if (t == null) return true;
      if (fromMs != null && t + BUCKET_MS < fromMs - padMs) return false;
      if (toMs != null && t > toMs) return false;
      return true;
    })
    .map((f) => path.join(dir, f));
}

function all(db: duckdb.Database, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) =>
    db.all(sql, (err: Error | null, rows: any[]) => (err ? reject(err) : resolve(rows))),
  );
}

function parseLevels(s: unknown): [number, number][] {
  if (typeof s !== "string") return [];
  try {
    return JSON.parse(s) as [number, number][];
  } catch {
    return [];
  }
}

function filelist(files: string[]): string {
  if (files.length === 0) return "";
  if (files.length === 1) return `'${files[0].replace(/'/g, "''")}'`;
  return `[${files.map((f) => `'${f.replace(/'/g, "''")}'`).join(", ")}]`;
}

export async function loadNative01Market(opts: LoadOptions): Promise<Native01Event[]> {
  const { dir, env, market, fromMs, toMs } = opts;
  const streamDir = (s: string) => path.join(dir, env, s, market);

  const snapshotFiles = filterFiles(streamDir("snapshot"), fromMs, toMs, 2 * 60 * 60 * 1000);
  if (snapshotFiles.length === 0) throw new Error(`no snapshot data at ${streamDir("snapshot")}`);
  const deltaFiles = filterFiles(streamDir("delta"), fromMs, toMs, 2 * 60 * 60 * 1000);
  const tradeFiles = filterFiles(streamDir("trade"), fromMs, toMs, 0);

  const parts: string[] = [];
  parts.push(
    `SELECT 'snapshot' AS kind, ts, bids, asks, NULL::VARCHAR AS side, NULL::DOUBLE AS price, NULL::DOUBLE AS size FROM read_parquet(${filelist(snapshotFiles)})`,
  );
  if (deltaFiles.length > 0)
    parts.push(
      `SELECT 'delta' AS kind, ts, bids, asks, NULL, NULL, NULL FROM read_parquet(${filelist(deltaFiles)})`,
    );
  if (tradeFiles.length > 0)
    parts.push(
      `SELECT 'trade' AS kind, ts, NULL, NULL, side, price, size FROM read_parquet(${filelist(tradeFiles)})`,
    );

  const db = new duckdb.Database(":memory:");
  try {
    const rows = await all(db, `${parts.join(" UNION ALL ")} ORDER BY ts`);
    const events: Native01Event[] = [];
    for (const r of rows) {
      const ts = Number(r.ts);
      if (r.kind === "trade") {
        if (r.price == null || r.size == null) continue;
        events.push({ kind: "trade", ts, trade: { side: r.side as Side, price: r.price, size: r.size, ts } });
      } else {
        events.push({ kind: r.kind, ts, bids: parseLevels(r.bids), asks: parseLevels(r.asks) });
      }
    }
    return events;
  } finally {
    await new Promise<void>((res) => db.close(() => res()));
  }
}
