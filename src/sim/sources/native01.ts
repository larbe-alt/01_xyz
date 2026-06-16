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
import { existsSync } from "node:fs";
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

export async function loadNative01Market(opts: LoadOptions): Promise<Native01Event[]> {
  const { dir, env, market } = opts;
  const streamDir = (s: string) => path.join(dir, env, s, market);
  const glob = (s: string) => `${streamDir(s).replace(/'/g, "''")}/*.parquet`;

  const present = (["snapshot", "delta", "trade"] as const).filter((s) => existsSync(streamDir(s)));
  if (!present.includes("snapshot")) throw new Error(`no snapshot data at ${streamDir("snapshot")}`);

  const parts: string[] = [];
  if (present.includes("snapshot"))
    parts.push(
      `SELECT 'snapshot' AS kind, ts, ts_local, bids, asks, NULL::VARCHAR AS side, NULL::DOUBLE AS price, NULL::DOUBLE AS size FROM read_parquet('${glob("snapshot")}')`,
    );
  if (present.includes("delta"))
    parts.push(
      `SELECT 'delta' AS kind, ts, ts_local, bids, asks, NULL, NULL, NULL FROM read_parquet('${glob("delta")}')`,
    );
  if (present.includes("trade"))
    parts.push(
      `SELECT 'trade' AS kind, ts, ts_local, NULL, NULL, side, price, size FROM read_parquet('${glob("trade")}')`,
    );

  const db = new duckdb.Database(":memory:");
  try {
    const rows = await all(db, `${parts.join(" UNION ALL ")} ORDER BY ts, ts_local`);
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
