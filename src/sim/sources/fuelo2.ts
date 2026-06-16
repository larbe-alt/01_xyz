/**
 * fuel_o2 recorder loader.
 *
 * The VPS recorder (project fuel_o2, archived to B2) writes a DIFFERENT on-disk
 * schema than this repo's recorder: flat files named
 * `<date>_<stream>_<MARKET>.parquet`, with scaled-integer prices/sizes stored as
 * VARCHAR, `side` ∈ {buy,sell}, and `depth_update.quantity` as a SIGNED delta
 * (negative = liquidity removed). This module maps that into the sim's normalized
 * events so the engine never sees the on-disk shape.
 *
 * Scale: prices and sizes are fixed-point with 1e9 scale (verified against known
 * levels — ETH ≈ 2075.74, USDT ≈ 0.999). TODO: source per-market scale from
 * market metadata instead of assuming uniform 1e9.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import duckdb from "duckdb";
import type { Side, MarketTrade } from "../types.js";

export const SCALE = 1e9;

export interface BookLevel {
  side: Side;
  price: number;
  size: number;
}

export type StreamEvent =
  | { kind: "update"; t: number; side: Side; price: number; delta: number }
  | { kind: "trade"; t: number; trade: MarketTrade };

export interface LoadedMarket {
  /** Absolute levels from the first recorded snapshot — the book's base state. */
  base: BookLevel[];
  /** Time-ordered deltas + trades after the base snapshot. */
  stream: StreamEvent[];
}

function all(db: duckdb.Database, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) =>
    db.all(sql, (err: Error | null, rows: any[]) => (err ? reject(err) : resolve(rows))),
  );
}

function q(file: string): string {
  return `'${file.replace(/'/g, "''")}'`;
}

const toSide = (s: string): Side => (s === "buy" ? "bid" : "ask");

export interface LoadOptions {
  dir: string;
  date: string; // e.g. "2026-05-23"
  market: string; // e.g. "USDT-USDC"
}

export async function loadFuelo2Market(opts: LoadOptions): Promise<LoadedMarket> {
  const { dir, date, market } = opts;
  const snapFile = path.join(dir, `${date}_depth_snapshot_${market}.parquet`);
  const updFile = path.join(dir, `${date}_depth_update_${market}.parquet`);
  const trdFile = path.join(dir, `${date}_trades_${market}.parquet`);

  for (const [label, f] of [["snapshot", snapFile], ["depth_update", updFile], ["trades", trdFile]] as const) {
    if (!existsSync(f)) throw new Error(`missing ${label} parquet: ${f}`);
  }

  const db = new duckdb.Database(":memory:");
  try {
    // Base = the FIRST snapshot in the file (min seq group), as absolute levels.
    const baseRows = await all(
      db,
      `WITH s AS (SELECT * FROM read_parquet(${q(snapFile)}))
       SELECT side, TRY_CAST(price AS DOUBLE) AS price, TRY_CAST(quantity AS DOUBLE) AS qty
       FROM s WHERE seq = (SELECT min(seq) FROM s)`,
    );
    const baseSeqRow = await all(db, `SELECT min(seq) AS s FROM read_parquet(${q(snapFile)})`);
    const baseSeq = Number(baseSeqRow[0].s);

    const base: BookLevel[] = baseRows
      .filter((r) => r.price != null && r.qty != null)
      .map((r) => ({ side: toSide(r.side), price: r.price / SCALE, size: r.qty / SCALE }));

    // Merged, time-ordered deltas (after the base snapshot) + trades.
    const rows = await all(
      db,
      `SELECT 'update' AS kind, recorded_at_ms AS t, seq, side,
              TRY_CAST(price AS DOUBLE) AS price, TRY_CAST(quantity AS DOUBLE) AS qty
         FROM read_parquet(${q(updFile)}) WHERE seq > ${baseSeq}
       UNION ALL
       SELECT 'trade' AS kind, recorded_at_ms AS t, seq, side,
              TRY_CAST(price AS DOUBLE) AS price, TRY_CAST(quantity AS DOUBLE) AS qty
         FROM read_parquet(${q(trdFile)})
       ORDER BY t, seq`,
    );

    const stream: StreamEvent[] = [];
    for (const r of rows) {
      if (r.price == null || r.qty == null || r.t == null) continue;
      const t = Number(r.t);
      const side = toSide(r.side);
      const price = r.price / SCALE;
      if (r.kind === "update") {
        stream.push({ kind: "update", t, side, price, delta: r.qty / SCALE });
      } else {
        stream.push({ kind: "trade", t, trade: { side, price, size: Math.abs(r.qty) / SCALE, ts: t } });
      }
    }

    return { base, stream };
  } finally {
    await new Promise<void>((r) => db.close(() => r()));
  }
}
